// options.js — saves and loads the two settings (Redmine URL + API key).
//
// The key idea here is chrome.storage.local: a small storage box that belongs to
// the extension and lives on this computer. We write settings into it and read
// them back later from other parts of the extension (like the service worker).

const urlInput = document.getElementById("url");
const keyInput = document.getElementById("key");
const saveButton = document.getElementById("save");
const statusText = document.getElementById("status");

// 1) When the settings page opens, load any previously-saved values and show them.
//    chrome.storage.local.get asks for the keys we want; it hands them back in an
//    object. If nothing was saved yet, the fields stay empty.
chrome.storage.local.get(["redmineUrl", "apiKey"], (saved) => {
  if (saved.redmineUrl) urlInput.value = saved.redmineUrl;
  if (saved.apiKey) keyInput.value = saved.apiKey;
});

// 2) When Save is clicked, write the current field values into storage.
saveButton.addEventListener("click", () => {
  chrome.storage.local.set(
    {
      redmineUrl: urlInput.value.trim(),
      apiKey: keyInput.value.trim(),
    },
    () => {
      // This callback runs once the save has finished.
      statusText.textContent = "Saved.";
      setTimeout(() => (statusText.textContent = ""), 1500);
    }
  );
});
