/**
 * Asking before the window goes while Settings hold changes nobody saved.
 *
 * The page keeps an unsaved Settings draft while its panel is closed or its
 * project is left, and objects to being unloaded while it holds one — which
 * in a browser brings up the browser's own "Leave site?" question. Electron
 * answers that objection by quietly not closing, so on its own the window
 * would simply refuse to shut with no word why. The shell asks instead, in a
 * dialog of its own: keep editing, or close and let the draft go.
 *
 * `onStay` runs when the answer is to keep editing, so whatever let the close
 * begin can be undone and the next close asks again.
 */
function guardUnsavedSettings(win, dialog, onStay = () => {}) {
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Keep editing", "Close anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Settings not saved",
      message: "Some settings are not saved.",
      detail: "You changed a project's settings and did not press Save. Closing now loses those changes.",
    });
    // Ignoring the page's objection is what lets it go.
    if (choice === 1) event.preventDefault();
    else onStay();
  });
}

module.exports = { guardUnsavedSettings };
