const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AWS = require('aws-sdk');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();

// Initialize Google Generative AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:4173',
    'https://libpwa-frontend.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Configure AWS S3 (Cloudflare R2)
const s3 = new AWS.S3({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  region: 'auto',
  signatureVersion: 'v4',
  s3ForcePathStyle: true,
  httpOptions: {
    timeout: 300000,      // 5 min timeout for large files
    connectTimeout: 10000 // 10s connect timeout
  }
});

// Use memoryStorage but increase limit — we'll stream via multipart
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // increased to 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

// Upload using S3 multipart — much faster for large files
const uploadToS3 = async (file, folder) => {
  const key = `${folder}/${Date.now()}_${file.originalname}`;
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks (S3 minimum)

  // For small files under 10MB, use regular upload
  if (file.buffer.length < 10 * 1024 * 1024) {
    const params = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    };
    await s3.upload(params).promise();
    return {
      Location: `${process.env.R2_PUBLIC_URL}/${key}`,
      Key: key
    };
  }

  // For larger files, use multipart upload
  console.log(`Using multipart upload for ${(file.buffer.length / 1024 / 1024).toFixed(1)}MB file`);

  const multipart = await s3.createMultipartUpload({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: file.mimetype,
  }).promise();

  const uploadId = multipart.UploadId;
  const parts = [];

  try {
    // Split buffer into chunks and upload in parallel
    const chunks = [];
    for (let i = 0; i < file.buffer.length; i += CHUNK_SIZE) {
      chunks.push(file.buffer.slice(i, i + CHUNK_SIZE));
    }

    // Upload chunks with concurrency limit of 3
    const CONCURRENCY = 3;
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((chunk, batchIndex) => {
          const partNumber = i + batchIndex + 1;
          console.log(`Uploading part ${partNumber}/${chunks.length}`);
          return s3.uploadPart({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: chunk,
          }).promise().then(data => ({ ETag: data.ETag, PartNumber: partNumber }));
        })
      );
      parts.push(...batchResults);
    }

    // Sort parts by part number before completing
    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    await s3.completeMultipartUpload({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }).promise();

    console.log(`✅ Multipart upload complete: ${key}`);
  } catch (err) {
    // Clean up failed multipart upload
    await s3.abortMultipartUpload({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
    }).promise();
    throw err;
  }

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

// AI Summary Generation
const generateSummaryFromMetadata = async (title, author, category) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `Create a specific, accurate 3-sentence technical summary for the book "${title}" by ${author || 'unknown author'}. 
      Research and explain:
      - What the actual subject matter is
      - Key concepts or topics covered
      - Why this is valuable for engineering/computer science students
      Be specific and avoid generic phrases.`
    });
    return response.text;
  } catch (error) {
    console.error('AI Generation Error:', error);
    try {
      const fallbackResponse = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: `Briefly summarize what "${title}" by ${author} is about for engineering students.`
      });
      return fallbackResponse.text;
    } catch (fallbackError) {
      return `"${title}" provides comprehensive coverage of ${category ? category.toLowerCase() : 'technical'} concepts essential for TCET Mumbai students.`;
    }
  }
};

// ==================== ROUTES ====================

app.post('/api/books/generate-summary', async (req, res) => {
  try {
    const { title, author, category } = req.body;
    if (!title) return res.status(400).json({ error: 'Book title is required' });
    const summary = await generateSummaryFromMetadata(title, author, category);
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate summary', details: error.message });
  }
});

app.post('/api/upload/book', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const fileSizeMB = (req.file.size / 1024 / 1024).toFixed(1);
    console.log(`📚 Uploading book: ${req.file.originalname} (${fileSizeMB}MB)`);

    const result = await uploadToS3(req.file, 'books');
    console.log('✅ Book upload successful');

    res.json({
      message: 'Book uploaded successfully',
      fileUrl: result.Location,
      key: result.Key
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload book', details: error.message });
  }
});

app.post('/api/upload/notice', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await uploadToS3(req.file, 'notices');
    res.json({ message: 'Notice uploaded successfully', fileUrl: result.Location, key: result.Key });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload notice' });
  }
});

app.delete('/api/delete-file', async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) return res.status(400).json({ error: 'File URL is required' });
    await deleteFromS3(fileUrl);
    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend server is running' });
});

app.get('/api/test-aws', async (req, res) => {
  try {
    await s3.headBucket({ Bucket: process.env.R2_BUCKET_NAME }).promise();
    res.json({ status: 'R2 Connected ✅', bucket: process.env.R2_BUCKET_NAME });
  } catch (error) {
    res.status(500).json({ status: 'R2 Connection Failed ❌', error: error.message });
  }
});

app.get('/api/ai/test-gemini-2', async (req, res) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: "Explain what Zigbee technology is in 2 sentences for engineering students."
    });
    res.json({ status: '✅ Gemini 2.0 Flash Working!', response: response.text });
  } catch (error) {
    res.status(500).json({ error: 'Gemini failed', details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend server running on port ${PORT}`);
});