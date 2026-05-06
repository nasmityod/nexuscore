'use strict';

(function () {
  function getHost() {
    var id = 'nexus-toast-host';
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'toast-host';
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(message, type) {
    var host = getHost();
    var t = document.createElement('div');
    var kind = type || 'info';
    t.className = 'toast toast-' + kind;
    t.textContent = message;
    host.appendChild(t);
    requestAnimationFrame(function () {
      t.classList.add('is-in');
    });
    setTimeout(function () {
      t.classList.remove('is-in');
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 220);
    }, 2800);
  }

  window.NexusComponents = window.NexusComponents || {};
  window.NexusComponents.showToast = showToast;
})();
