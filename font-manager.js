/**
 * Font manager for handling font detection and downloading from Google Fonts
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { promisify } = require('util');
const stream = require('stream');

// Promisify the stream.pipeline for async/await usage
const pipeline = promisify(stream.pipeline);

/**
 * Extract font families from SVG content
 * @param {string} svgContent - The SVG file content
 * @returns {string[]} - Array of font family names
 */
function extractFontsFromSVG(svgContent) {
  const fontFamilies = new Set();
  
  // Find font-family in styles with various quote styles
  const fontFamilyRegex = /font-family\s*:\s*['"]?([^'",;]+)['"]?/g;
  let match;
  
  while ((match = fontFamilyRegex.exec(svgContent)) !== null) {
    fontFamilies.add(match[1].trim());
  }
  
  // Find font-family attributes in XML
  const fontAttrRegex = /font-family\s*=\s*["']([^"']+)["']/g;
  while ((match = fontAttrRegex.exec(svgContent)) !== null) {
    fontFamilies.add(match[1].trim());
  }
  
  // Look for more complex CSS with font-family
  const cssRegex = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let cssMatch;
  while ((cssMatch = cssRegex.exec(svgContent)) !== null) {
    const cssContent = cssMatch[1];
    const fontInCssRegex = /font-family\s*:\s*['"]?([^'",;]+)['"]?/g;
    let fontMatch;
    
    while ((fontMatch = fontInCssRegex.exec(cssContent)) !== null) {
      fontFamilies.add(fontMatch[1].trim());
    }
  }
  
  // Find tspan elements with font-family attributes
  const tspanRegex = /<tspan[^>]*font-family\s*=\s*["']([^"']+)["'][^>]*>/g;
  while ((match = tspanRegex.exec(svgContent)) !== null) {
    fontFamilies.add(match[1].trim());
  }
  
  // Find text elements with font-family attributes
  const textRegex = /<text[^>]*font-family\s*=\s*["']([^"']+)["'][^>]*>/g;
  while ((match = textRegex.exec(svgContent)) !== null) {
    fontFamilies.add(match[1].trim());
  }
  
  // Look for @font-face rules which might reference Google Fonts
  const fontFaceRegex = /@font-face\s*{[^}]*?font-family\s*:\s*['"]?([^'",;]+)['"]?[^}]*?}/g;
  while ((match = fontFaceRegex.exec(svgContent)) !== null) {
    fontFamilies.add(match[1].trim());
  }
  
  // Remove fallback fonts (keep only the primary font)
  return Array.from(fontFamilies).map(font => {
    // If the font contains commas, take the first part (primary font)
    return font.split(',')[0].trim();
  });
}

/**
 * Check if a font exists in the local fonts directory
 * @param {string} fontName - Name of the font to check
 * @param {string} fontsDir - Path to the fonts directory
 * @returns {boolean} - Whether the font exists locally
 */
function fontExistsLocally(fontName, fontsDir) {
  try {
    const files = fs.readdirSync(fontsDir);
    
    // Normalize font name for comparison (remove spaces, lowercase)
    const normalizedFontName = fontName.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    return files.some(file => {
      // Remove extension and normalize for comparison
      const fileName = path.basename(file, path.extname(file))
                          .toLowerCase()
                          .replace(/[^a-z0-9]/g, '');
      
      return fileName.includes(normalizedFontName);
    });
  } catch (error) {
    console.error(`Error checking if font exists locally: ${error.message}`);
    return false;
  }
}

/**
 * Download a Google Font using Google Fonts API
 * @param {string} fontName - Name of the font to download
 * @param {string} fontsDir - Path to save the font
 * @returns {Promise<boolean>} - Whether the download was successful
 */
async function downloadGoogleFont(fontName, fontsDir) {
  try {
    console.log(`Attempting to download font: ${fontName}`);
    
    // Skip if it's a system font
    const systemFonts = ['Arial', 'Helvetica', 'Times', 'Times New Roman', 'Courier', 'Courier New', 
                          'Verdana', 'Georgia', 'Palatino', 'Garamond', 'Bookman', 'Tahoma', 'Trebuchet MS'];
    if (systemFonts.includes(fontName)) {
      console.log(`${fontName} is a system font, skipping download.`);
      return false;
    }
    
    // Get Google Fonts API key from environment variable
    const apiKey = process.env.GOOGLE_FONTS_API_KEY;
    if (!apiKey) {
      throw new Error('Google Fonts API key not configured - set GOOGLE_FONTS_API_KEY environment variable');
    }
    
    // Helper function for HTTP GET requests
    function httpGet(url) {
      return new Promise((resolve, reject) => {
        https.get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP error: ${response.statusCode}`));
            return;
          }
          
          let data = '';
          response.on('data', (chunk) => data += chunk);
          response.on('end', () => {
            try {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } catch (e) {
              // If not JSON, return the raw data
              resolve(data);
            }
          });
        }).on('error', reject);
      });
    }
    
    // Helper function to check if a URL exists without downloading it
    function httpHead(url) {
      return new Promise((resolve, reject) => {
        const options = { method: 'HEAD' };
        
        https.request(url, options, (response) => {
          if (response.statusCode === 200) {
            resolve(true);
          } else {
            reject(new Error(`HTTP error: ${response.statusCode}`));
          }
        }).on('error', reject).end();
      });
    }
    
    // Query the Google Fonts API for information about the font
    const apiUrl = `https://www.googleapis.com/webfonts/v1/webfonts?key=${apiKey}`;
    console.log('Fetching font information from Google Fonts API');
    
    const fontsData = await httpGet(apiUrl);
    if (!fontsData.items || !Array.isArray(fontsData.items)) {
      throw new Error('Invalid response from Google Fonts API');
    }
    
    // Find the font in the API response
    const fontInfo = fontsData.items.find(item => 
      item.family.toLowerCase() === fontName.toLowerCase()
    );
    
    if (!fontInfo) {
      throw new Error(`Font "${fontName}" not found in Google Fonts catalog - check spelling or try a different font`);
    }
    
    console.log(`Found font "${fontName}" in Google Fonts API`);
    
    // Check if TTF format is available
    if (!fontInfo.files || !fontInfo.files.regular) {
      throw new Error(`No files information available for ${fontName}`);
    }
    
    // Get the TTF file URL - replace the ending with .ttf
    // Note: Google Fonts API doesn't directly provide TTF URLs, so we need to transform
    const fontUrl = fontInfo.files.regular;
    const ttfUrl = fontUrl.replace(/\.woff2$|\.woff$/, '.ttf');
    
    console.log(`Checking if TTF format is available: ${ttfUrl}`);
    
    try {
      // Verify the TTF URL actually exists
      await httpHead(ttfUrl);
      console.log(`TTF format available for ${fontName}`);
    } catch (error) {
      throw new Error(`TTF format not available for "${fontName}" - Google Fonts may only provide WOFF/WOFF2 for this font`);
    }
    
    // Create fonts directory if it doesn't exist
    if (!fs.existsSync(fontsDir)) {
      fs.mkdirSync(fontsDir, { recursive: true });
    }
    
    console.log(`Downloading TTF font: ${ttfUrl}`);
    
    // Generate filename for the TTF font
    const normalizedName = fontName.replace(/\s+/g, '');
    const fileName = `${normalizedName}-Regular.ttf`;
    const filePath = path.join(fontsDir, fileName);
    
    try {
      // Download the TTF font
      await new Promise((resolve, reject) => {
        https.get(ttfUrl, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download font: ${response.statusCode}`));
            return;
          }
          
          const fileStream = fs.createWriteStream(filePath);
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            fileStream.close();
            console.log(`Downloaded ${fileName}`);
            resolve();
          });
          
          fileStream.on('error', (err) => {
            fs.unlink(filePath, () => {});
            reject(err);
          });
        }).on('error', (err) => reject(err));
      });
      
      // Update type.xml file for font mapping
      await updateTypeXmlFile(fontName, fontsDir);
      
      console.log(`Successfully downloaded TTF font: ${fontName}`);
      return true;
    } catch (error) {
      console.error(`Error downloading TTF font: ${error.message}`);
      return false;
    }
  } catch (error) {
    console.error(`Error downloading Google Font ${fontName}: ${error.message}`);
    return false;
  }
}

/**
 * Updates the type.xml file with the new font mapping
 * @param {string} fontName - Name of the font
 * @param {string} fontsDir - Path to the fonts directory
 * @returns {Promise<void>}
 */
async function updateTypeXmlFile(fontName, fontsDir) {
  try {
    const typeXmlPath = path.join(fontsDir, 'type.xml');
    let xmlContent = '';
    
    // Create a new XML file if it doesn't exist
    if (!fs.existsSync(typeXmlPath)) {
      xmlContent = '<?xml version="1.0"?>\n<typemap>\n</typemap>';
    } else {
      xmlContent = fs.readFileSync(typeXmlPath, 'utf8');
    }
    
    // Get all TTF files for this font
    const fontFiles = fs.readdirSync(fontsDir)
      .filter(file => {
        const normalizedName = fontName.replace(/\s+/g, '').toLowerCase();
        return file.toLowerCase().startsWith(normalizedName) && 
               file.toLowerCase().endsWith('.ttf');
      });
    
    if (fontFiles.length === 0) {
      console.warn(`No TTF font files found for ${fontName}, cannot update type.xml`);
      return;
    }
    
    console.log(`Found ${fontFiles.length} TTF font files for ${fontName}, updating type.xml mappings`);
    
    // Get the closing typemap tag position
    const closingTagPos = xmlContent.lastIndexOf('</typemap>');
    
    if (closingTagPos === -1) {
      console.error('Invalid type.xml format');
      return;
    }
    
    // Remove any existing entries for this font to avoid duplicates
    const entryPattern = new RegExp(`<type[^>]*family\\s*=\\s*["']${fontName}["'][^>]*>`, 'gi');
    let matches;
    let entriesToRemove = [];
    
    while ((matches = entryPattern.exec(xmlContent)) !== null) {
      // Find the end of this entry
      const startPos = matches.index;
      const endPos = xmlContent.indexOf('/>', startPos) + 2;
      if (endPos > startPos) {
        entriesToRemove.push(xmlContent.substring(startPos, endPos));
      }
    }
    
    // Remove existing entries
    for (const entry of entriesToRemove) {
      xmlContent = xmlContent.replace(entry, '');
    }
    
    // Add new entries
    let newEntries = '';
    
    for (const fontFile of fontFiles) {
      // Extract font properties from filename
      const filenameLower = fontFile.toLowerCase();
      const isItalic = filenameLower.includes('-italic') || filenameLower.includes('-bolditalic');
      const isBold = filenameLower.includes('-bold') || filenameLower.includes('-bolditalic');
      const isSemiBold = filenameLower.includes('-semibold');
      const isLight = filenameLower.includes('-light');
      const isMedium = filenameLower.includes('-medium');
      const isRegular = filenameLower.includes('-regular');
      const isExtraBold = filenameLower.includes('-extrabold');
      
      // Determine weight based on file name
      let weight = '400'; // Regular
      if (isBold) weight = '700';
      if (isSemiBold) weight = '600';
      if (isMedium) weight = '500';
      if (isLight) weight = '300';
      if (isExtraBold) weight = '800';
      
      // Determine the style
      const style = isItalic ? 'Italic' : 'Normal';
      
      // Create a full name based on weight and style
      let fullname = fontName;
      if (isBold && isItalic) fullname += ' Bold Italic';
      else if (isBold) fullname += ' Bold';
      else if (isSemiBold && isItalic) fullname += ' SemiBold Italic';
      else if (isSemiBold) fullname += ' SemiBold';
      else if (isMedium && isItalic) fullname += ' Medium Italic';
      else if (isMedium) fullname += ' Medium';
      else if (isLight && isItalic) fullname += ' Light Italic';
      else if (isLight) fullname += ' Light';
      else if (isItalic) fullname += ' Italic';
      else if (isRegular) fullname += ' Regular';
      else if (isExtraBold && isItalic) fullname += ' ExtraBold Italic';
      else if (isExtraBold) fullname += ' ExtraBold';
      else fullname += ' Regular'; // Default to Regular if no specific style found
      
      // Determine the name to use in the type field
      let typeName = fontName;
      if (isBold && isItalic) typeName += ' Bold Italic';
      else if (isBold) typeName += ' Bold';
      else if (isSemiBold && isItalic) typeName += ' SemiBold Italic';
      else if (isSemiBold) typeName += ' SemiBold';
      else if (isMedium && isItalic) typeName += ' Medium Italic';
      else if (isMedium) typeName += ' Medium';
      else if (isLight && isItalic) typeName += ' Light Italic';
      else if (isLight) typeName += ' Light';
      else if (isItalic) typeName += ' Italic';
      else if (!isRegular && !fontFile.includes('-')) {
        // For files without a variant suffix, use the base name + Regular
        typeName += ' Regular';
      }
      
      // Create a type entry with absolute path
      const fontPath = path.resolve(fontsDir, fontFile).replace(/\\/g, '/');
      const entry = `  <type name="${typeName}" fullname="${fullname}" family="${fontName}" style="${style}" stretch="Normal" weight="${weight}" glyphs="${fontPath}" />\n`;
      
      console.log(`Adding mapping: ${typeName} -> ${fontPath}`);
      
      newEntries += entry;
    }
    
    // Also add a simple entry for just the font name without style for better matching
    const defaultFontFile = fontFiles.find(file => file.toLowerCase().includes('-regular')) || fontFiles[0];
    const defaultFontPath = path.resolve(fontsDir, defaultFontFile).replace(/\\/g, '/');
    const defaultEntry = `  <type name="${fontName}" fullname="${fontName} Regular" family="${fontName}" style="Normal" stretch="Normal" weight="400" glyphs="${defaultFontPath}" />\n`;
    
    newEntries += defaultEntry;
    
    // Construct the updated XML content
    let updatedXmlContent = xmlContent.substring(0, closingTagPos).trim();
    if (!updatedXmlContent.endsWith('\n')) {
      updatedXmlContent += '\n';
    }
    updatedXmlContent += newEntries;
    updatedXmlContent += xmlContent.substring(closingTagPos);
    
    // Write the updated XML back to the file
    fs.writeFileSync(typeXmlPath, updatedXmlContent);
    console.log(`Updated ${typeXmlPath} with ${fontName} mappings (${fontFiles.length} variants)`);
  } catch (error) {
    console.error(`Error updating type.xml: ${error.message}`);
  }
}

/**
 * Ensure all fonts from the SVG are available with detailed status reporting
 * @param {string} svgPath - Path to the SVG file
 * @param {string} fontsDir - Path to the fonts directory
 * @param {Function} statusCallback - Callback function to report status updates
 * @returns {Promise<Object>} - Font processing results
 */
async function ensureFontsAvailable(svgPath, fontsDir, statusCallback = null) {
  const results = {
    fontsDetected: [],
    fontsFoundLocally: [],
    fontsDownloaded: [],
    fontsFailed: [],
    errors: []
  };

  try {
    if (statusCallback) statusCallback('Analyzing SVG for font requirements...');
    
    // Read SVG content
    const svgContent = fs.readFileSync(svgPath, 'utf8');
    
    // Extract font families
    const fontFamilies = extractFontsFromSVG(svgContent);
    results.fontsDetected = fontFamilies;
    
    if (fontFamilies.length === 0) {
      if (statusCallback) statusCallback('No custom fonts detected in SVG - using system defaults');
      console.log('No fonts detected in SVG');
      return results;
    }
    
    if (statusCallback) statusCallback(`Found ${fontFamilies.length} font(s): ${fontFamilies.join(', ')}`);
    console.log(`Detected fonts in SVG: ${fontFamilies.join(', ')}`);
    
    // Check and download missing fonts
    for (const fontName of fontFamilies) {
      if (fontExistsLocally(fontName, fontsDir)) {
        if (statusCallback) statusCallback(`✅ "${fontName}" found locally`);
        console.log(`Font "${fontName}" already exists locally`);
        results.fontsFoundLocally.push(fontName);
      } else {
        if (statusCallback) statusCallback(`⬬ "${fontName}" not found locally - downloading from Google Fonts...`);
        console.log(`Font "${fontName}" not found locally, attempting to download...`);
        
        try {
          const success = await downloadGoogleFont(fontName, fontsDir);
          
          if (success) {
            if (statusCallback) statusCallback(`✅ Successfully downloaded "${fontName}" from Google Fonts`);
            console.log(`Successfully downloaded font: ${fontName}`);
            results.fontsDownloaded.push(fontName);
          } else {
            if (statusCallback) statusCallback(`❌ Failed to download "${fontName}" - will use system fallback`);
            console.log(`Could not download font: ${fontName}. Will use fallback fonts.`);
            results.fontsFailed.push(fontName);
          }
        } catch (error) {
          const errorMsg = `Download failed for "${fontName}": ${error.message}`;
          if (statusCallback) statusCallback(`❌ ${errorMsg}`);
          console.error(errorMsg);
          results.fontsFailed.push(fontName);
          results.errors.push(errorMsg);
        }
      }
    }
    
    // Summary status
    const totalFonts = fontFamilies.length;
    const availableFonts = results.fontsFoundLocally.length + results.fontsDownloaded.length;
    
    if (availableFonts === totalFonts) {
      if (statusCallback) statusCallback(`🎉 All ${totalFonts} font(s) are available for conversion`);
    } else {
      if (statusCallback) statusCallback(`⚠️ ${availableFonts}/${totalFonts} fonts available - ${results.fontsFailed.length} will use fallbacks`);
    }
    
  } catch (error) {
    const errorMsg = `Error ensuring fonts available: ${error.message}`;
    if (statusCallback) statusCallback(`❌ ${errorMsg}`);
    console.error(errorMsg);
    results.errors.push(errorMsg);
  }
  
  return results;
}

module.exports = {
  extractFontsFromSVG,
  fontExistsLocally,
  downloadGoogleFont,
  ensureFontsAvailable,
  updateTypeXmlFile
};