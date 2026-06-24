const UI = {
    switchView: (viewName, viewsObject) => {
        Object.values(viewsObject).forEach(v => {
            v.classList.remove('active');
            v.classList.add('hidden');
        });
        viewsObject[viewName].classList.add('active');
        viewsObject[viewName].classList.remove('hidden');
    },

    showError: (message) => {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerText = message;
        container.appendChild(toast);
        
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => { 
            toast.classList.remove('show'); 
            setTimeout(() => toast.remove(), 300); 
        }, 5000);
    }
};