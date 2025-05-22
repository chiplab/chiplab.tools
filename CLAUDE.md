# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chiplab.tools is an SVG to PDF converter web application. It allows users to upload SVG files through a web interface and converts them to PDF format using ImageMagick's `convert` command-line tool.

## Development Setup

### Prerequisites
- Node.js
- npm
- ImageMagick (must be installed on your system)

### Installation
```bash
npm install
```

### Running the Server
```bash
npm start
```

The server runs on port 3001 by default.

## Project Structure

- `server.js` - Express.js server that handles file uploads and conversion
- `public/` - Static web assets (HTML, CSS, JS)
- `fonts/` - OpenSans font family used for PDF conversion
- `temp/` - Temporary storage for uploads and conversions (cleaned up automatically)

## Core Functionality

1. **File Upload**
   - SVG files are uploaded via a drag-and-drop interface
   - Maximum file size: 10MB
   - Only SVG files are accepted

2. **Conversion Process**
   - Files are saved to the `temp/` directory
   - ImageMagick's `convert` command converts SVG to PDF at 300dpi
   - OpenSans fonts are used for consistent text rendering
   - PDF is sent back to the client for download
   - Temporary files are cleaned up after download

3. **Error Handling**
   - Client-side validation for SVG files
   - Server-side MIME type filtering
   - Error handling for conversion failures
   - Cleanup routines for temporary files

## Important Notes

- The application requires ImageMagick to be installed on the host system
- The `MAGICK_FONT_PATH` environment variable is set to the absolute path of the fonts directory
- Temporary files older than 1 hour are automatically deleted on server startup
- The web interface is intentionally simple and minimal