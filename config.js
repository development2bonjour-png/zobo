/*
 * ZOBO app settings — the only file an admin edits on GitHub.
 * apiUrl: the Apps Script web app address (Apps Script editor > Deploy > Manage deployments > Web app URL, ending in /exec).
 * directPhotos (optional): by default product photos load straight from each supplier's own website, which is faster; the script fetches
 *   only the ones the browser cannot show. Add  directPhotos: false  (after a comma on the apiUrl line) to always fetch them through the
 *   script instead, so supplier websites never see your computer's address.
 */
window.JARVIS_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/AKfycbxGBjSd5SCWhOetXHamTXz2vcBYIZIr0UOvvxnn6Uw6sAS-1lbsUDrVazrQWAxDOGKWqg/exec"
};
