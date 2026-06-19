import AdmZip from 'adm-zip';
import { parseStringPromise } from 'xml2js'; // Run 'npm install xml2js' to handle the manifest cleanly

export async function parseEpubFile(fileBuffer) {
  const zip = new AdmZip(fileBuffer);
  const zipEntries = zip.getEntries();

  // 1. Locate the container.xml to find the root .opf file
  const containerEntry = zipEntries.find(e => e.entryName === 'META-INF/container.xml');
  if (!containerEntry) throw new Error('Invalid EPUB: Missing container.xml');
  
  const containerXml = containerEntry.getData().toString('utf8');
  const containerData = await parseStringPromise(containerXml);
  const opfPath = containerData.container.rootfiles[0].rootfile[0].$.跑['full-path'] || containerData.container.rootfiles[0].rootfile[0].$['full-path'];

  // Get base directory of the OPF file for resolving relative paths (e.g., OEBPS/)
  const baseDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2. Parse the OPF file for metadata and spine order
  const opfEntry = zipEntries.find(e => e.entryName === opfPath);
  const opfXml = opfEntry.getData().toString('utf8');
  const opfData = await parseStringPromise(opfXml);

  // Fix random title string issue by targeting metadata accurately
  const metadata = opfData.package.metadata[0];
  const title = metadata['dc:title'] ? metadata['dc:title'][0] : 'Unknown Title';

  // Build manifest map for quick ID-to-file lookups
  const manifestItems = opfData.package.manifest[0].item;
  const manifestMap = {};
  manifestItems.forEach(item => {
    manifestMap[item.$.id] = item.$.href;
  });

  // Extract sequential chapter order from the spine
  const spineItems = opfData.package.spine[0].itemref;
  const chapters = [];

  // 3. Process each chapter in structural order
  for (const spine of spineItems) {
    const idref = spine.$.idref;
    const relativeHref = manifestMap[idref];
    if (!relativeHref) continue;

    const fullHref = `${baseDir}${relativeHref}`;
    const chapterEntry = zipEntries.find(e => e.entryName === fullHref);
    if (!chapterEntry) continue;

    let htmlContent = chapterEntry.getData().toString('utf8');

    // 4. FIX IMAGES: Inline images by mapping internal zip references to Base64
    const imgRegex = /(<img\s+[^>]*src=["'])([^"']*)(["'][^>]*>)/gi;
    htmlContent = htmlContent.replace(imgRegex, (match, p1, src, p3) => {
      // Resolve path relative to the chapter file position
      const chapterDir = fullHref.includes('/') ? fullHref.substring(0, fullHref.lastIndexOf('/') + 1) : '';
      const normalizedSrc = normalizePath(`${chapterDir}${src}`);
      
      const imgEntry = zipEntries.find(e => e.entryName === normalizedSrc);
      if (imgEntry) {
        const ext = src.split('.').pop().toLowerCase();
        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
        const base64Img = imgEntry.getData().toString('base64');
        return `${p1}data:${mimeType};base64,${base64Img}${p3}`;
      }
      return match; // Fallback if image not found in zip
    });

    // 5. FIX SPACING: Insert clean line breaks around structural block elements before rendering text
    let formattedText = htmlContent
      .replace(/<\/p>/gi, '</p>\n\n')
      .replace(/<br\s*\/?>/gi, '<br/>\n')
      .replace(/<\/h[1-6]>/gi, match => `${match}\n\n`);

    // Clean up title values embedded in chapters for the sidebar index
    const titleMatch = htmlContent.match(/<title>([\s\S]*?)<\/title>/i);
    const chapterTitle = titleMatch ? titleMatch[1].trim() : `Chapter ${chapters.length + 1}`;

    chapters.push({
      title: chapterTitle,
      id: idref,
      html: formattedText
    });
  }

  return {
    title,
    chapters // Passed directly to feed the Sidebar and Reader component
  };
}

// Utility to resolve path elements like '../images/pic.jpg' relative to base directory files
function normalizePath(path) {
  const parts = path.split('/');
  const stack = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}