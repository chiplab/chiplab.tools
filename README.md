# SVG to PDF Converter

A web application that converts SVG files to PDF while preserving vector quality and fonts.

## Features

- SVG to PDF conversion with vector preservation
- Dynamic Google Fonts loading when fonts are not available locally
- Font detection from SVG files
- Automatic font embedding
- High-quality vector rendering with Inkscape

## Requirements

- **Inkscape**: High-quality vector-based SVG to PDF conversion
  - Install on macOS: `brew install inkscape`
  - Install on Ubuntu/Debian: `sudo apt-get install inkscape`
  - Windows: Download from [inkscape.org](https://inkscape.org/release/)

## Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Start the server: `npm start`
4. Open http://localhost:3001 in your browser

## Development

Run with automatic server restart on file changes:

```
npm run dev
```

## How It Works

1. The server analyzes uploaded SVG files to detect font usage
2. If fonts are not available locally, they are downloaded from Google Fonts
3. The SVG is preprocessed to optimize for PDF conversion
4. Inkscape converts the SVG to PDF with fonts embedded
5. The resulting PDF is sent to the user for download

## Project Structure

- `server.js` - Express.js server that handles file uploads and conversion
- `font-manager.js` - Handles font detection and downloading
- `public/` - Static web assets (HTML, CSS, JS)
- `fonts/` - Directory for downloaded fonts
- `temp/` - Temporary storage for uploads and conversions

## Configuration

The application uses these environment variables:

- `PORT`: The port to run the server on (default: 3001)