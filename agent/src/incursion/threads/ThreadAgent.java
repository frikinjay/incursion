package incursion.threads;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.lang.management.LockInfo;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.CodeSource;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lets Incursion look at the game's threads while it runs, so it can tell a player which thread is stuck and which mod
 * it is stuck in.
 *
 * <p>Started with {@code -javaagent:incursion-threads.jar=<folder>}. It opens a socket on the loopback address only,
 * writes its port and a random token to {@code <folder>/threads.port}, and then waits. Nothing is collected until
 * Incursion connects and sends the token; each request gets one snapshot of every thread as JSON (state, CPU time, lock,
 * stack, and the jar each frame's class came from). It never changes the game.
 */
public final class ThreadAgent {
    private static final int MAX_FRAMES = 48;
    private static final Pattern JAR = Pattern.compile("([^/\\\\!#]+\\.jar)", Pattern.CASE_INSENSITIVE);

    private static Instrumentation instrumentation;
    private static final Map<String, String> sources = new HashMap<String, String>();
    private static long lastIndex;

    private ThreadAgent() {}

    public static void premain(String args, Instrumentation inst) { start(args, inst); }

    public static void agentmain(String args, Instrumentation inst) { start(args, inst); }

    private static void start(final String folder, Instrumentation inst) {
        instrumentation = inst;
        Thread t = new Thread(new Runnable() { public void run() { serve(folder); } }, "Incursion Thread Viewer");
        t.setDaemon(true);
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
    }

    private static void serve(String folder) {
        try {
            ThreadMXBean mx = ManagementFactory.getThreadMXBean();
            if (mx.isThreadCpuTimeSupported()) mx.setThreadCpuTimeEnabled(true);
            if (mx.isThreadContentionMonitoringSupported()) mx.setThreadContentionMonitoringEnabled(true);
            // Minecraft launches with java.net.preferIPv6Addresses=system, which can make the loopback address ::1;
            // Incursion connects to 127.0.0.1, so bind that explicitly.
            ServerSocket server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            byte[] raw = new byte[24];
            new SecureRandom().nextBytes(raw);
            StringBuilder token = new StringBuilder();
            for (byte b : raw) token.append(String.format("%02x", b & 0xff));
            File dir = new File(folder == null || folder.isEmpty() ? "." : folder);
            dir.mkdirs();
            File tmp = new File(dir, "threads.port.tmp");
            OutputStream out = new FileOutputStream(tmp);
            try { out.write((server.getLocalPort() + " " + token).getBytes(StandardCharsets.UTF_8)); } finally { out.close(); }
            File port = new File(dir, "threads.port");
            port.delete();
            tmp.renameTo(port);
            port.deleteOnExit();
            while (true) {
                Socket s = server.accept();
                try {
                    s.setSoTimeout(5000);
                    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                    String line = in.readLine();
                    if (line == null || !line.trim().equals(token.toString())) continue;
                    s.getOutputStream().write(snapshot(mx).getBytes(StandardCharsets.UTF_8));
                    s.getOutputStream().flush();
                } catch (Throwable ignored) {
                    // One bad request must not end the viewer.
                } finally {
                    try { s.close(); } catch (Throwable ignored) {}
                }
            }
        } catch (Throwable t) {
            // The game runs on without the viewer.
        }
    }

    private static String snapshot(ThreadMXBean mx) {
        ThreadInfo[] infos = mx.dumpAllThreads(mx.isObjectMonitorUsageSupported(), mx.isSynchronizerUsageSupported());
        long[] dead = mx.findDeadlockedThreads();
        Set<Long> deadlocked = new HashSet<Long>();
        if (dead != null) for (long id : dead) deadlocked.add(id);
        indexSources(infos);

        MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        StringBuilder b = new StringBuilder(64 * 1024);
        b.append("{\"time\":").append(System.currentTimeMillis())
            .append(",\"uptime\":").append(ManagementFactory.getRuntimeMXBean().getUptime())
            .append(",\"heapUsed\":").append(heap.getUsed())
            .append(",\"heapMax\":").append(heap.getMax())
            .append(",\"threads\":[");
        boolean first = true;
        for (ThreadInfo t : infos) {
            if (t == null) continue;
            if (!first) b.append(',');
            first = false;
            long id = t.getThreadId();
            b.append("{\"id\":").append(id)
                .append(",\"name\":").append(str(t.getThreadName()))
                .append(",\"state\":").append(str(t.getThreadState().name()))
                .append(",\"cpu\":").append(mx.isThreadCpuTimeEnabled() ? mx.getThreadCpuTime(id) : -1)
                .append(",\"blockedTime\":").append(t.getBlockedTime())
                .append(",\"blockedCount\":").append(t.getBlockedCount())
                .append(",\"waitedTime\":").append(t.getWaitedTime())
                .append(",\"inNative\":").append(t.isInNative())
                .append(",\"deadlocked\":").append(deadlocked.contains(id));
            LockInfo lock = t.getLockInfo();
            if (lock != null) b.append(",\"lock\":").append(str(lock.getClassName()));
            if (t.getLockOwnerName() != null) b.append(",\"lockOwner\":").append(str(t.getLockOwnerName())).append(",\"lockOwnerId\":").append(t.getLockOwnerId());
            b.append(",\"stack\":[");
            StackTraceElement[] st = t.getStackTrace();
            for (int i = 0; i < st.length && i < MAX_FRAMES; i++) {
                StackTraceElement f = st[i];
                if (i > 0) b.append(',');
                b.append("{\"c\":").append(str(f.getClassName()))
                    .append(",\"m\":").append(str(f.getMethodName()))
                    .append(",\"l\":").append(f.getLineNumber());
                String src = sources.get(f.getClassName());
                if (src != null && !src.isEmpty()) b.append(",\"j\":").append(str(src));
                b.append('}');
            }
            b.append("],\"depth\":").append(st.length).append('}');
        }
        return b.append("]}").toString();
    }

    // Which jar each class on a stack came from. Looking through every loaded class is slow in a big modpack, so it
    // happens only when a stack has a class not seen before, and at most every few seconds.
    private static void indexSources(ThreadInfo[] infos) {
        Set<String> wanted = new HashSet<String>();
        for (ThreadInfo t : infos) {
            if (t == null) continue;
            StackTraceElement[] st = t.getStackTrace();
            for (int i = 0; i < st.length && i < MAX_FRAMES; i++) if (!sources.containsKey(st[i].getClassName())) wanted.add(st[i].getClassName());
        }
        if (wanted.isEmpty() || instrumentation == null || System.currentTimeMillis() - lastIndex < 3000) return;
        lastIndex = System.currentTimeMillis();
        for (Class<?> c : instrumentation.getAllLoadedClasses()) {
            String name = c.getName();
            if (!wanted.contains(name)) continue;
            sources.put(name, jarOf(c));
            wanted.remove(name);
            if (wanted.isEmpty()) break;
        }
        for (String name : wanted) sources.put(name, "");
    }

    private static String jarOf(Class<?> c) {
        try {
            CodeSource cs = c.getProtectionDomain() == null ? null : c.getProtectionDomain().getCodeSource();
            URL url = cs == null ? null : cs.getLocation();
            if (url == null) return "";
            String s = java.net.URLDecoder.decode(url.toString(), "UTF-8");
            Matcher m = JAR.matcher(s);
            String last = "";
            while (m.find()) last = m.group(1);
            return last;
        } catch (Throwable t) {
            return "";
        }
    }

    private static String str(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch)); else b.append(ch);
            }
        }
        return b.append('"').toString();
    }
}
