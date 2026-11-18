// Applies the owner's stored board theme before first paint, so a chosen theme never flashes the other one.
// Kept outside the bundle (the board's CSP forbids inline scripts) and served as cached for good: change its name if its content changes.
try {
  var theme = window.localStorage.getItem("entail.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (error) {
  // Without storage the board follows the system theme.
}
