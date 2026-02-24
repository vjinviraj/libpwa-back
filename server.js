const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AWS = require('aws-sdk');
const { GoogleGenAI } = require('@google/genai'); // Make sure you have the NEW SDK
require('dotenv').config();

const app = express();

// Initialize Google Generative AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Test these model names in order
const geminiModels = [
  "gemini-2.0-flash",        // Latest fast model
  "gemini-2.0-flash-exp",    // Experimental version
  "gemini-1.5-flash",        // Previous fast model
  "gemini-1.5-pro",          // High quality model
  "gemini-1.5-flash-001"     // Specific version
];

// Updated CORS configuration
app.use(cors({
  origin: [
    'http://localhost:4173',  // Add this - your current dev server
    'http://localhost:5173',  // Vite default
    'https://pwalib-frontend.vercel.app', // Your actual Vercel domain
    'https://libpwa-frontend.vercel.app/' // Replace with your real domain
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  region: 'auto',
  signatureVersion: 'v4',
  s3ForcePathStyle: true
});

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

// Upload file to S3 - NO ACL
const uploadToS3 = async (file, folder) => {
  const key = `${folder}/${Date.now()}_${file.originalname}`;

  const params = {
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype
    // No ACL - R2 doesn't support it
  };

  await s3.upload(params).promise();

  return {
    Location: `${process.env.R2_PUBLIC_URL}/${key}`,
    Key: key
  };
};

// Delete file from S3
const deleteFromS3 = (fileUrl) => {
  const key = fileUrl.replace(`${process.env.R2_PUBLIC_URL}/`, '');

  return s3.deleteObject({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key
  }).promise();
};

// AI Summary Generation Helper Function - USING GEMINI 2.5 FLASH
const generateSummaryFromMetadata = async (title, author, category) => {
  try {
    console.log('Generating AI summary for:', title);
    
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",  // Use 2.0-flash (2.5 might not be widely available yet)
      contents: `Create a specific, accurate 3-sentence technical summary for the book "${title}" by ${author || 'unknown author'}. 
      
      Research and explain:
      - What the actual subject matter is (if it's "Zigbee Introduction", explain what Zigbee technology is)
      - Key concepts or topics covered
      - Why this is valuable for engineering/computer science students
      
      Be specific and avoid generic phrases. Provide real technical details about the topic.`
    });

    const summary = response.text;
    console.log('✅ AI Summary generated successfully with Gemini 2.0 Flash');
    return summary;
    
  } catch (error) {
    console.error('AI Generation Error:', error);
    
    // Try gemini-1.5-flash as fallback if 2.0 doesn't work
    try {
      console.log('Trying gemini-1.5-flash as fallback...');
      const fallbackResponse = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: `Briefly summarize what "${title}" by ${author} is about for engineering students.`
      });
      return fallbackResponse.text;
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
      return `"${title}" provides comprehensive coverage of ${category ? category.toLowerCase() : 'technical'} concepts essential for TCET Mumbai students. The book offers both theoretical foundations and practical applications relevant to modern engineering challenges.`;
    }
  }
};

// ==================== ROUTES ====================

// AI Summary Generation Route
app.post('/api/books/generate-summary', async (req, res) => {
  try {
    const { title, author, category } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Book title is required' });
    }

    console.log('Generating AI summary for:', title);
    const summary = await generateSummaryFromMetadata(title, author, category);
    
    console.log('AI summary generated successfully');
    res.json({ summary });

  } catch (error) {
    console.error('Summary generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate summary',
      details: error.message 
    });
  }
});

// Test route for Gemini 2.5/2.0 Flash
app.get('/api/ai/test-gemini-2', async (req, res) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: "Explain what Zigbee technology is in 2 sentences for engineering students."
    });
    
    res.json({ 
      status: '✅ Gemini 2.0 Flash Working!',
      model: 'gemini-2.0-flash',
      response: response.text 
    });
  } catch (error) {
    // Try 1.5 if 2.0 fails
    try {
      const fallbackResponse = await ai.models.generateContent({
        model: "gemini-1.5-flash", 
        contents: "Say 'Hello World' in one word."
      });
      
      res.json({ 
        status: '✅ Gemini 1.5 Flash Working (2.0 not available)',
        model: 'gemini-1.5-flash',
        response: fallbackResponse.text 
      });
    } catch (fallbackError) {
      res.status(500).json({ 
        error: 'Both Gemini models failed',
        details: fallbackError.message,
        availableModels: 'Try: gemini-2.0-flash, gemini-1.5-flash, gemini-1.5-pro'
      });
    }
  }
});

app.post('/api/upload/book', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('Uploading file to S3...');
    const result = await uploadToS3(req.file, 'books');
    
    console.log('Upload successful:', result.Location);
    
    res.json({
      message: 'Book uploaded successfully',
      fileUrl: result.Location,
      key: result.Key
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Failed to upload book',
      details: error.message 
    });
  }
});

app.post('/api/upload/notice', upload.single('file'), async (req, res) => {
  try {
    const result = await uploadToS3(req.file, 'notices');
    
    res.json({
      message: 'Notice uploaded successfully',
      fileUrl: result.Location,
      key: result.Key
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload notice' });
  }
});

app.delete('/api/delete-file', async (req, res) => {
  try {
    const { fileUrl } = req.body;
    
    if (!fileUrl) {
      return res.status(400).json({ error: 'File URL is required' });
    }

    await deleteFromS3(fileUrl);
    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend server is running' });
});

// Test AWS connectivity
app.get('/api/test-aws', async (req, res) => {
  try {
    await s3.headBucket({ Bucket: process.env.R2_BUCKET_NAME }).promise();
    res.json({ 
      status: 'R2 Connected ✅', 
      bucket: process.env.R2_BUCKET_NAME,
      publicUrl: process.env.R2_PUBLIC_URL
    });
  } catch (error) {
    res.status(500).json({ status: 'R2 Connection Failed ❌', error: error.message });
  }
});



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`CORS enabled for all origins`);
  console.log(`AI Summary route: POST /api/books/generate-summary`);
});