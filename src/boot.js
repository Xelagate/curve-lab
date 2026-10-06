// CSP forbids inline scripts, so the load-failure banner is wired here.
const banner = document.getElementById('banner')
document.getElementById('retry').addEventListener('click', () => location.reload())
window.addEventListener('error', () => banner.classList.add('show'))
