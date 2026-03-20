# Use Node.js 20 LTS
FROM node:20-slim

# Install qpdf, ghostscript, and poppler-utils (for pdfunite)
RUN apt-get update && apt-get install -y \
    qpdf \
    ghostscript \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Expose port
EXPOSE 3000

# Start the Express server
CMD ["npm", "start"]
