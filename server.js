// Load environment variables from .env file if present
try {
  require('dotenv').config();
} catch (e) {
  console.log('dotenv module not available, skipping .env loading');
}

const express = require('express');
const multer = require('multer');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const fontManager = require('./font-manager');

const app = express();
const PORT = 3001;

// PDF output size configuration
const TARGET_PDF_SIZE = 102; // Target PDF size in points

// Configure multer for file uploads
const upload = multer({
    dest: 'temp/',
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'image/svg+xml') {
            cb(null, true);
        } else {
            cb(new Error('Only SVG files allowed'));
        }
    }
});

// Serve static files from public directory
app.use(express.static('public'));

// Convert SVG to PDF endpoint
app.post('/convert', upload.single('svg'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No SVG file uploaded' });
    }

    const inputPath = req.file.path;
    const inputSvgPath = `${inputPath}.svg`;
    const outputPath = path.join('temp', `${req.file.filename}.pdf`);
    
    // Rename uploaded file to have .svg extension
    fs.renameSync(inputPath, inputSvgPath);

    try {
        // Set font path environment variable with absolute path
        const fontPath = path.resolve(__dirname, 'fonts');
        
        // Check for fonts in the SVG and download if needed
        console.log('Checking for fonts in SVG...');
        
        // Create a status callback that sends updates to the client
        const fontStatusCallback = (message) => {
            console.log(`Font Status: ${message}`);
            // For now, just log - we'll enhance this with SSE later
        };
        
        const fontResults = await fontManager.ensureFontsAvailable(inputSvgPath, fontPath, fontStatusCallback);
        
        // Report font processing results
        console.log('\n=== FONT PROCESSING SUMMARY ===');
        if (fontResults.fontsDetected.length === 0) {
            console.log('✅ No custom fonts detected - using system defaults');
        } else {
            console.log(`📋 Fonts detected: ${fontResults.fontsDetected.join(', ')}`);
            if (fontResults.fontsFoundLocally.length > 0) {
                console.log(`✅ Found locally: ${fontResults.fontsFoundLocally.join(', ')}`);
            }
            if (fontResults.fontsDownloaded.length > 0) {
                console.log(`⬇️  Downloaded from Google: ${fontResults.fontsDownloaded.join(', ')}`);
            }
            if (fontResults.fontsFailed.length > 0) {
                console.log(`❌ Failed to obtain: ${fontResults.fontsFailed.join(', ')} (will use fallbacks)`);
                fontResults.errors.forEach(error => console.log(`   ❌ ${error}`));
            }
        }
        console.log('===============================\n');
        
        // Preprocess SVG to ensure viewBox is properly set
        console.log('Preprocessing SVG structure...');
        await preprocessSvg(inputSvgPath);
        
        // Modify SVG to have exact target dimensions
        console.log('Applying proportional scaling for PDF output...');
        await modifySvgDimensions(inputSvgPath, TARGET_PDF_SIZE);
        
        // Read SVG to check dimensions
        const svgContent = fs.readFileSync(inputSvgPath, 'utf8');
        
        console.log(`Converting: ${req.file.originalname}`);
        console.log(`Font path: ${fontPath}`);
        console.log(`Input path: ${inputSvgPath}`);
        console.log(`Output path: ${outputPath}`);
        
        // Check if we have text elements that need font handling
        const hasTextElements = /<text[^>]*>/i.test(svgContent);
        
        if (hasTextElements) {
            // Preprocess the SVG to enhance font handling
            await preprocessSvgForBetterFonts(inputSvgPath);
        }
        
        // Check for Inkscape in various possible locations
        const inkscapePaths = [
            '/usr/bin/inkscape',                    // Linux/Unix
            '/usr/local/bin/inkscape',              // Homebrew on Intel Mac
            '/opt/homebrew/bin/inkscape',           // Homebrew on Apple Silicon Mac
            '/Applications/Inkscape.app/Contents/MacOS/inkscape', // macOS app
            'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',  // Windows
            'flatpak run org.inkscape.Inkscape'    // Flatpak on Linux
        ];
        
        // Find the first existing Inkscape path
        let inkscapePath = null;
        for (const pathToCheck of inkscapePaths) {
            if (fs.existsSync(pathToCheck)) {
                inkscapePath = pathToCheck;
                break;
            }
        }
        
        if (!inkscapePath) {
            // Try using PATH environment
            try {
                inkscapePath = exec('which inkscape', { encoding: 'utf8' }).toString().trim();
            } catch (e) {
                console.error('Inkscape not found on system');
                return res.status(500).json({ error: 'Inkscape is required but not installed on this system' });
            }
        }
        
        console.log(`Using Inkscape at: ${inkscapePath}`);
        
        // Check Inkscape version to determine correct parameters
        let inkscapeVersion = "1.0"; // Default to 1.0+ to use new parameters
        try {
            const versionOutput = exec(`${inkscapePath} --version`, { encoding: 'utf8' }).toString().trim();
            console.log(`Inkscape version output: ${versionOutput}`);
            
            // Extract version number from output
            const versionMatch = versionOutput.match(/Inkscape\s+(\d+\.\d+)/i);
            if (versionMatch) {
                inkscapeVersion = versionMatch[1];
                console.log(`Extracted Inkscape version: ${inkscapeVersion}`);
            } else {
                console.log('Could not extract version number, using default 1.0+ parameters');
            }
        } catch (e) {
            console.log('Could not determine Inkscape version, using default 1.0+ parameters');
        }
        
        // Set environment variables for font handling
        const env = {
            ...process.env,
            // Add font directory to XDG_DATA_DIRS to help Inkscape find fonts
            XDG_DATA_DIRS: `${fontPath}:${process.env.XDG_DATA_DIRS || ''}`,
            // Set FONTCONFIG_PATH for font configuration
            FONTCONFIG_PATH: fontPath,
            // Set type.xml for font mapping (helps both Inkscape and ImageMagick)
            MAGICK_TYPEMAP: path.join(fontPath, 'type.xml')
        };
        
        console.log(`Converting SVG with modified dimensions to produce exactly ${TARGET_PDF_SIZE}x${TARGET_PDF_SIZE}pt PDF output`);
        
        // Use Inkscape to convert the dimension-modified SVG to PDF
        let inkscapeOptions = [
            '--export-filename', outputPath,
            '--export-area-page',            // Export the entire SVG page (now sized to target dimensions)
            '--export-dpi=72',               // 72 DPI = 1pt = 1px
            '--export-text-to-path',         // Convert text to paths
            '--export-pdf-version=1.5',      // PDF version
            '--export-type=pdf',             // Output type
            inputSvgPath
        ];
        
        console.log(`Using --export-area-page with SVG dimensions set to ${TARGET_PDF_SIZE}pt`);
        
        console.log(`Inkscape command: ${inkscapePath} ${inkscapeOptions.join(' ')}`);
        
        console.log('Starting PDF conversion with Inkscape...');
        execFile(inkscapePath, inkscapeOptions, { env }, (error, stdout, stderr) => {
            if (stderr) {
                console.log('Inkscape stderr:', stderr);
            }
            if (stdout) {
                console.log('Inkscape stdout:', stdout);
            }
            
            if (error) {
                console.error('\n=== CONVERSION ERROR ===');
                console.error('Inkscape conversion failed:', error.message);
                console.error('Command:', inkscapePath, inkscapeOptions.join(' '));
                if (error.code) console.error('Exit code:', error.code);
                if (error.signal) console.error('Signal:', error.signal);
                console.error('=======================\n');
                
                cleanup(inputSvgPath, outputPath);
                return res.status(500).json({ 
                    error: 'PDF conversion failed', 
                    details: error.message,
                    fontIssues: fontResults.fontsFailed.length > 0 ? 
                        `Missing fonts: ${fontResults.fontsFailed.join(', ')}` : null
                });
            }
            
            console.log('✅ PDF conversion completed successfully');
            console.log(`📄 Generated: ${outputPath}`);
            
            // Send the PDF file
            res.download(outputPath, req.file.originalname.replace('.svg', '.pdf'), (err) => {
                if (err) {
                    console.error('PDF download error:', err);
                } else {
                    console.log('📤 PDF download started');
                }
                
                // Clean up files after download
                cleanup(inputSvgPath, outputPath);
            });
        });
    } catch (error) {
        console.error('Error processing SVG:', error);
        cleanup(inputSvgPath, outputPath);
        return res.status(500).json({ error: 'Processing failed' });
    }
});

// Clean up temporary files
function cleanup(inputPath, outputPath) {
    try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (err) {
        console.error('Cleanup error:', err);
    }
}

// Cleanup old temp files on startup
function cleanupTempFolder() {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
        return;
    }
    
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        
        // Delete files older than 1 hour
        if (Date.now() - stats.mtime.getTime() > 60 * 60 * 1000) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up old file: ${file}`);
        }
    });
}

// Start server
app.listen(PORT, () => {
    console.log(`SVG to PDF converter running on port ${PORT}`);
    cleanupTempFolder();
});

/**
 * Preprocess SVG file to ensure viewBox is properly set and helps with PDF sizing
 * @param {string} svgPath - Path to the SVG file
 * @returns {Promise<void>}
 */
async function preprocessSvg(svgPath) {
    try {
        console.log(`Preprocessing SVG: ${svgPath}`);
        let svgContent = fs.readFileSync(svgPath, 'utf8');
        
        // Check if SVG has a viewBox attribute
        const hasViewBox = /<svg[^>]*viewBox\s*=\s*["'][^"']*["']/i.test(svgContent);
        const svgTagMatch = svgContent.match(/<svg[^>]*>/i);
        
        if (svgTagMatch && !hasViewBox) {
            console.log('No viewBox found, adding viewBox based on width/height');
            
            // Try to extract width and height
            const widthMatch = svgContent.match(/<svg[^>]*width\s*=\s*["']([^"']*)["']/i);
            const heightMatch = svgContent.match(/<svg[^>]*height\s*=\s*["']([^"']*)["']/i);
            
            if (widthMatch && heightMatch) {
                // Extract numeric part and unit
                const widthValue = widthMatch[1].trim();
                const heightValue = heightMatch[1].trim();
                
                // Strip units if present and convert to number
                const width = parseFloat(widthValue);
                const height = parseFloat(heightValue);
                
                if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
                    // Add viewBox attribute
                    const viewBox = `0 0 ${width} ${height}`;
                    const newSvgTag = svgTagMatch[0].replace(/>$/, ` viewBox="${viewBox}">`);
                    svgContent = svgContent.replace(svgTagMatch[0], newSvgTag);
                    console.log(`Added viewBox: ${viewBox}`);
                }
            }
        }
        
        // Extract existing viewBox values for debugging
        if (hasViewBox) {
            const viewBoxMatch = svgContent.match(/viewBox\s*=\s*["']([^"']*)["']/i);
            if (viewBoxMatch) {
                console.log(`Original viewBox: ${viewBoxMatch[1]}`);
            }
        }
        
        // Save the modified SVG content
        fs.writeFileSync(svgPath, svgContent, 'utf8');
        
        // Find and modify text elements to use embedded (non-system) fonts and improve rendering
        const textElements = svgContent.match(/<text[^>]*>[^<]*<\/text>/gi) || [];
        
        if (textElements.length > 0) {
            console.log(`Found ${textElements.length} text elements, optimizing for PDF rendering`);
            
            // Get the SVG tag 
            const svgTagMatch = svgContent.match(/<svg[^>]*>/i);
            
            // Add SVG attributes to help with text rendering
            if (svgTagMatch && !svgContent.includes('text-rendering')) {
                const textRenderingAttr = 'text-rendering="geometricPrecision" shape-rendering="geometricPrecision"';
                const newSvgTag = svgTagMatch[0].replace(/>$/, ` ${textRenderingAttr}>`);
                svgContent = svgContent.replace(svgTagMatch[0], newSvgTag);
                console.log('Added rendering attributes to SVG for better text handling');
            }
            
            // Enhance text elements for better rendering
            for (const textElement of textElements) {
                // Add font-weight and font-style if not present to ensure proper rendering
                if (!textElement.includes('font-weight') && !textElement.includes('font-style')) {
                    const enhancedText = textElement.replace(/<text/, '<text font-weight="normal" font-style="normal"');
                    svgContent = svgContent.replace(textElement, enhancedText);
                }
            }
            
            // Save the modified SVG content again with text enhancements
            fs.writeFileSync(svgPath, svgContent, 'utf8');
            console.log('Enhanced text elements for better rendering');
        }
    } catch (error) {
        console.error(`Error preprocessing SVG: ${error.message}`);
    }
}

/**
 * Special preprocessing for better font rendering with Inkscape
 * @param {string} svgPath - Path to the SVG file
 * @returns {Promise<void>}
 */
async function preprocessSvgForBetterFonts(svgPath) {
    try {
        console.log(`Enhancing SVG for better font rendering: ${svgPath}`);
        let svgContent = fs.readFileSync(svgPath, 'utf8');
        let modified = false;
        
        // Find all text elements
        const textElements = svgContent.match(/<text[^>]*>.*?<\/text>/gis) || [];
        
        if (textElements.length === 0) {
            console.log('No text elements found to enhance');
            return;
        }
        
        console.log(`Found ${textElements.length} text elements to enhance`);
        
        // Get font directory absolute path
        const fontPath = path.resolve(__dirname, 'fonts');
        
        // Check if type.xml exists - this is created by the font-manager
        const typeXmlPath = path.join(fontPath, 'type.xml');
        let fontMappings = [];
        
        if (fs.existsSync(typeXmlPath)) {
            // Read the type.xml file to get font mappings
            const typeXmlContent = fs.readFileSync(typeXmlPath, 'utf8');
            
            // Extract font mappings
            const fontEntryRegex = /<type\s+name="([^"]+)"\s+[^>]*?family="([^"]+)"[^>]*?glyphs="([^"]+)"/gi;
            let match;
            while ((match = fontEntryRegex.exec(typeXmlContent)) !== null) {
                fontMappings.push({
                    name: match[1],
                    family: match[2],
                    path: match[3]
                });
            }
            
            console.log(`Found ${fontMappings.length} font mappings in type.xml`);
        }
        
        // Get list of available TTF fonts
        const availableFonts = fs.readdirSync(fontPath)
            .filter(file => file.toLowerCase().endsWith('.ttf'))
            .map(file => {
                // Extract normalized font name from filename
                const fontName = path.basename(file, '.ttf')
                    .replace(/-.*$/, '') // Remove weight/style suffixes
                    .replace(/([A-Z])/g, ' $1') // Add spaces before capital letters
                    .trim();
                return {
                    fileName: file,
                    fontName: fontName
                };
            });
        
        console.log(`Available TTF fonts: ${availableFonts.map(f => f.fontName).join(', ')}`);
        
        // Add a style block with font-face declarations
        const fontFamilies = new Set();
        
        // Collect all font families from text elements
        for (const text of textElements) {
            const fontMatch = text.match(/font-family\s*=\s*["']([^"']*)["']/i) || 
                              text.match(/font-family\s*:\s*([^;]*)/i);
            if (fontMatch) {
                // Get the primary font name (before any commas)
                const fontFamily = fontMatch[1].trim().split(',')[0].replace(/['"]*/g, '');
                fontFamilies.add(fontFamily);
            }
        }
        
        // If we have fonts, create @font-face declarations
        if (fontFamilies.size > 0) {
            let styleBlock = '<style type="text/css">\n';
            
            // Add font declarations for each font we found
            for (const fontFamily of fontFamilies) {
                // Find a matching font mapping from type.xml
                const exactMapping = fontMappings.find(m => 
                    m.family.toLowerCase() === fontFamily.toLowerCase()
                );
                
                const similarMapping = fontMappings.find(m => 
                    m.family.toLowerCase().includes(fontFamily.toLowerCase()) ||
                    fontFamily.toLowerCase().includes(m.family.toLowerCase())
                );
                
                const mapping = exactMapping || similarMapping;
                
                if (mapping) {
                    // Use the font mapping from type.xml
                    styleBlock += `@font-face {\n`;
                    styleBlock += `  font-family: '${fontFamily}';\n`;
                    styleBlock += `  font-style: normal;\n`;
                    styleBlock += `  font-weight: normal;\n`;
                    styleBlock += `  src: url("${mapping.path}") format("truetype");\n`;
                    styleBlock += `}\n`;
                    console.log(`Added @font-face for ${fontFamily} using type.xml mapping to ${mapping.path}`);
                } else {
                    // No mapping in type.xml, try to find a matching TTF file
                    const matchingFont = availableFonts.find(font => 
                        font.fontName.toLowerCase() === fontFamily.toLowerCase() ||
                        fontFamily.toLowerCase().includes(font.fontName.toLowerCase()) ||
                        font.fontName.toLowerCase().includes(fontFamily.toLowerCase())
                    );
                    
                    if (matchingFont) {
                        // Create a font-face rule with absolute path to the TTF file
                        const absoluteFontPath = path.join(fontPath, matchingFont.fileName);
                        styleBlock += `@font-face {\n`;
                        styleBlock += `  font-family: '${fontFamily}';\n`;
                        styleBlock += `  font-style: normal;\n`;
                        styleBlock += `  font-weight: normal;\n`;
                        styleBlock += `  src: url("${absoluteFontPath}") format("truetype");\n`;
                        styleBlock += `}\n`;
                        console.log(`Added @font-face for ${fontFamily} pointing to ${matchingFont.fileName}`);
                    } else {
                        console.log(`No matching TTF font found for ${fontFamily}`);
                        styleBlock += `@font-face {\n`;
                        styleBlock += `  font-family: '${fontFamily}';\n`;
                        styleBlock += `  font-style: normal;\n`;
                        styleBlock += `  font-weight: normal;\n`;
                        styleBlock += `}\n`;
                    }
                }
            }
            
            styleBlock += '</style>';
            
            // Remove any existing style blocks with font-face declarations
            svgContent = svgContent.replace(/<style[^>]*>[\s\S]*?@font-face[\s\S]*?<\/style>/gi, '');
            
            // Insert our new style block after the SVG opening tag
            const svgOpeningMatch = svgContent.match(/<svg[^>]*>/i);
            if (svgOpeningMatch) {
                const pos = svgOpeningMatch.index + svgOpeningMatch[0].length;
                svgContent = svgContent.slice(0, pos) + '\n' + styleBlock + svgContent.slice(pos);
                modified = true;
                console.log('Added style block with font-face declarations');
            }
        }
        
        // Process each text element to enhance it
        for (const originalText of textElements) {
            // Check if font-family is specified
            const fontFamilyMatch = originalText.match(/font-family\s*=\s*["']([^"']*)["']/i) || 
                                    originalText.match(/font-family\s*:\s*([^;]*)/i);
            
            if (fontFamilyMatch) {
                const fontFamily = fontFamilyMatch[1].trim().split(',')[0];
                
                // Add or update attributes for better rendering
                let newText = originalText;
                
                // Add font-weight if missing
                if (!originalText.includes('font-weight')) {
                    newText = newText.replace(/<text/, `<text font-weight="bold"`);
                }
                
                // Add specific styling with the font-family to ensure Inkscape uses it
                const fontStyle = `font-family: '${fontFamily}', sans-serif; text-rendering: geometricPrecision;`;
                
                if (newText.includes('style="')) {
                    // Append to existing style attribute
                    newText = newText.replace(/style="([^"]*)"/i, `style="$1; ${fontStyle}"`);
                } else {
                    // Add new style attribute
                    newText = newText.replace(/<text/, `<text style="${fontStyle}"`);
                }
                
                // Replace the original element with our enhanced version
                if (newText !== originalText) {
                    svgContent = svgContent.replace(originalText, newText);
                    modified = true;
                }
            }
        }
        
        if (modified) {
            console.log('Enhanced SVG text elements for better font rendering with Inkscape');
            fs.writeFileSync(svgPath, svgContent, 'utf8');
        }
    } catch (error) {
        console.error(`Error enhancing SVG for fonts: ${error.message}`);
    }
}

/**
 * Modify SVG dimensions to exact target size for precise PDF output with proportional scaling
 * @param {string} svgPath - Path to the SVG file
 * @param {number} targetSize - Target size in points
 * @returns {Promise<void>}
 */
async function modifySvgDimensions(svgPath, targetSize) {
    try {
        console.log(`Modifying SVG dimensions to ${targetSize}pt with proportional scaling for precise PDF output`);
        let svgContent = fs.readFileSync(svgPath, 'utf8');
        
        // Extract original width and height from the SVG
        const widthMatch = svgContent.match(/width="([^"]+)"/i);
        const heightMatch = svgContent.match(/height="([^"]+)"/i);
        
        let originalWidth = 151.1712; // Default fallback
        let originalHeight = 151.1712; // Default fallback
        
        if (widthMatch && heightMatch) {
            originalWidth = parseFloat(widthMatch[1]);
            originalHeight = parseFloat(heightMatch[1]);
            console.log(`Detected original dimensions: ${originalWidth} x ${originalHeight}`);
        }
        
        // Calculate scale factor to fit content proportionally
        const scaleFactor = targetSize / Math.max(originalWidth, originalHeight);
        console.log(`Scale factor: ${scaleFactor.toFixed(4)} (${Math.round(scaleFactor * 100)}%)`);
        
        // Find the SVG opening tag and replace it with exact dimensions and scaling
        const svgTagMatch = svgContent.match(/<svg[^>]*>/i);
        if (svgTagMatch) {
            // Create new SVG tag with target dimensions and proportional viewBox
            const newSvgTag = `<svg width="${targetSize}pt" height="${targetSize}pt" viewBox="0 0 ${targetSize} ${targetSize}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:se="http://www.pixopa.com">`;
            
            // Find the content after the opening SVG tag
            const contentAfterSvgTag = svgContent.substring(svgTagMatch.index + svgTagMatch[0].length);
            
            // Calculate center translation to center the scaled content within the target viewBox
            const scaledWidth = originalWidth * scaleFactor;
            const scaledHeight = originalHeight * scaleFactor;
            const centerX = (targetSize - scaledWidth) / 2;
            const centerY = (targetSize - scaledHeight) / 2;
            
            // Wrap all content in a transform group for scaling and centering
            const scaledContent = `<g transform="translate(${centerX}, ${centerY}) scale(${scaleFactor})">` + 
                                 contentAfterSvgTag.replace('</svg>', '') + 
                                 '</g></svg>';
            
            // Combine the new SVG tag with the scaled content
            svgContent = newSvgTag + scaledContent;
            
            // Save the modified SVG
            fs.writeFileSync(svgPath, svgContent, 'utf8');
            console.log(`Modified SVG to ${targetSize}pt x ${targetSize}pt with proportional scaling`);
            console.log(`Content scaled by ${Math.round(scaleFactor * 100)}% and centered within ${targetSize}x${targetSize}pt artboard`);
        } else {
            console.log('Could not find SVG opening tag to modify');
        }
    } catch (error) {
        console.error(`Error modifying SVG dimensions: ${error.message}`);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    process.exit(0);
});