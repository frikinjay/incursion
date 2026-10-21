// Output is escaped HTML, so file contents can't inject markup.
(() => {
    const esc = (s) => s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

    const NUM = /-?(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)[bslfd]?\b/iy;
    const DQ = /"(?:\\.|[^"\\\n])*"?/y;
    const SQ = /'(?:\\.|[^'\\\n])*'?/y;
    const LINE_HASH = /#.*/y;
    const LINE_SLASH = /\/\/.*/y;
    const BLOCK = /\/\*[\s\S]*?(?:\*\/|$)/y;

    const LANGS = {
        json: [[LINE_SLASH, 'com'], [BLOCK, 'com'], [/"(?:\\.|[^"\\\n])*"(?=\s*:)/y, 'key'], [DQ, 'str'], [NUM, 'num'], [/\b(?:true|false|null)\b/y, 'bool'], [/[{}[\]:,]/y, 'punc']],
        snbt: [[/"(?:\\.|[^"\\\n])*"(?=\s*:)/y, 'key'], [/[A-Za-z_][\w.+-]*(?=\s*:)/y, 'key'], [DQ, 'str'], [SQ, 'str'], [/\[[BIL];/y, 'punc'], [NUM, 'num'], [/\b(?:true|false)\b/y, 'bool'], [/[{}[\]:,]/y, 'punc']],
        toml: [[LINE_HASH, 'com'], [/^\s*\[\[?[^\]\n]*\]\]?/my, 'sec'], [/"""[\s\S]*?(?:"""|$)/y, 'str'], [/[A-Za-z0-9_.\-"']+(?=\s*=)/y, 'key'], [DQ, 'str'], [SQ, 'str'], [NUM, 'num'], [/\b(?:true|false)\b/y, 'bool'], [/[=[\],{}]/y, 'punc']],
        cfg: [[LINE_HASH, 'com'], [/[A-Za-z_][\w ]*(?=\s*\{)/y, 'sec'], [/[BIDSL]:(?:"[^"\n]*"|[\w.-]+)(?=\s*[=<])/y, 'key'], [DQ, 'str'], [NUM, 'num'], [/\b(?:true|false)\b/y, 'bool'], [/[={}<>]/y, 'punc']],
        properties: [[/[#!].*/y, 'com'], [/^[^=:\n#!]+(?=[=:])/my, 'key'], [/\b(?:true|false)\b/y, 'bool'], [NUM, 'num'], [/[=:]/y, 'punc']],
        yaml: [[LINE_HASH, 'com'], [/^\s*-?\s*[\w"'.-]+(?=\s*:)/my, 'key'], [DQ, 'str'], [SQ, 'str'], [NUM, 'num'], [/\b(?:true|false|null|yes|no)\b/y, 'bool'], [/[:\-[\]{},]/y, 'punc']],
        js: [[LINE_SLASH, 'com'], [BLOCK, 'com'], [/`(?:\\.|[^`\\])*`?/y, 'str'], [DQ, 'str'], [SQ, 'str'], [NUM, 'num'], [/\b(?:const|let|var|function|return|if|else|for|while|new|true|false|null|undefined|import|export|from|=>|of|in)\b/y, 'bool'], [/\b[A-Za-z_$][\w$]*(?=\s*\()/y, 'key'], [/[{}()[\];,.]/y, 'punc']],
        plain: []
    };

    function langFor(name) {
        const ext = name.toLowerCase().split('.').pop();
        if (['json', 'json5', 'mcmeta', 'jsonc'].includes(ext)) return 'json';
        if (ext === 'snbt' || ext === 'nbt') return 'snbt';
        if (ext === 'toml') return 'toml';
        if (ext === 'cfg') return 'cfg';
        if (['properties', 'ini', 'lang', 'txt', 'conf', 'options'].includes(ext) || name.endsWith('options.txt')) return 'properties';
        if (['yml', 'yaml'].includes(ext)) return 'yaml';
        if (['js', 'mjs', 'ts', 'zs'].includes(ext)) return 'js';
        return 'plain';
    }

    function highlight(text, lang) {
        const rules = LANGS[lang] || [];
        if (!rules.length) return esc(text);
        let out = '', plain = '', i = 0;
        const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
        outer: while (i < text.length) {
            for (const [re, cls] of rules) {
                re.lastIndex = i;
                const m = re.exec(text);
                if (m && m[0].length) {
                    flush();
                    out += `<span class="tok-${cls}">${esc(m[0])}</span>`;
                    i += m[0].length;
                    continue outer;
                }
            }
            // Skip whole words so a rule can't match mid-identifier.
            const w = /[A-Za-z0-9_]+|\s+|./y;
            w.lastIndex = i;
            const m = w.exec(text);
            plain += m[0];
            i += m[0].length;
        }
        flush();
        return out;
    }

    function validate(text, lang, name) {
        if (lang === 'json' && /\.(json|mcmeta)$/i.test(name)) {
            try { JSON.parse(text); return { ok: true, message: 'Valid JSON' }; }
            catch (e) {
                const pos = Number(e.message.match(/position (\d+)/)?.[1]);
                const line = Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : null;
                return { ok: false, message: line ? `JSON error on line ${line}` : 'Invalid JSON' };
            }
        }
        if (lang === 'snbt' || lang === 'json') {
            const stack = [];
            const pairs = { '}': '{', ']': '[' };
            let inStr = null;
            for (let i = 0; i < text.length; i++) {
                const c = text[i];
                if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
                if (c === '"' || c === "'") inStr = c;
                else if (c === '{' || c === '[') stack.push(c);
                else if (c === '}' || c === ']') { if (stack.pop() !== pairs[c]) return { ok: false, message: `Unbalanced “${c}” on line ${text.slice(0, i).split('\n').length}` }; }
            }
            if (stack.length) return { ok: false, message: `Unclosed “${stack[stack.length - 1]}”` };
            return { ok: true, message: 'Brackets Balanced' };
        }
        return null;
    }

    window.Highlight = { highlight, langFor, validate };
})();
