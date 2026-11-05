// jsPDF lazily imports html2canvas, DOMPurify and canvg for features this app never uses
// (doc.html(), SVG embedding). Aliasing them here keeps ~380 KB out of the bundle and offline cache.
const unused = () => {
  throw new Error('Not available in this build.');
};
export default unused;
export const Canvg = { fromString: unused };
