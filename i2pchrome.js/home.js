/* Minimal page behavior for home.html: collapsible sections driven by
   <button class="showhider" onclick="flipVisibility('id')"> */
function flipVisibility(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === "none" ? "block" : "none";
}

document.addEventListener("DOMContentLoaded", () => {
  var links = document.getElementById("fliplinks");
  var content = document.getElementById("info-content");
  if (links && content) {
    content.style.display = "none";
    links.addEventListener("click", () => flipVisibility("info-content"));
  }

  var version = document.getElementById("i2pbrowser-version");
  if (version && chrome.runtime.getManifest) {
    version.textContent = "i2pchrome.js v" + chrome.runtime.getManifest().version;
  }
});
