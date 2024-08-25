// Controllers/chatController.js

const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { PineconeStore } = require('@langchain/pinecone');
const { PDFLoader } = require('@langchain/community/document_loaders/fs/pdf');
const { DocxLoader } = require('@langchain/community/document_loaders/fs/docx');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { createLogger, transports, format } = require('winston');
const fs = require('fs');
const path = require('path');

// Initialize logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'chat.log' })
  ]
});
console.log( process.env.PINECONE_API_KEY)
// Initialize Pinecone client
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.questionAnswer = async (req, res) => {
  try {
    logger.info('Starting question answering process');

    const { question } = req.body;
    const namespace = "euler-namespace";

    if (!question) {
      logger.error('No question provided');
      return res.status(400).json({ error: 'No question provided' });
    }

    logger.info(`Received question: ${question}`);
    logger.info(`Searching in namespace: ${namespace || 'default'}`);

    // Initialize embeddings
    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      modelName: "models/embedding-001"
    });

    // Initialize Pinecone index
    const indexName = process.env.PINECONE_INDEX_NAME;
    if (!indexName) {
      throw new Error('PINECONE_INDEX_NAME is not set in environment variables');
    }
    const pineconeIndex = pinecone.Index(indexName);

    // Log index statistics
    const indexStats = await pineconeIndex.describeIndexStats();
    logger.info(`Pinecone index stats: ${JSON.stringify(indexStats)}`);

    // Create vector store with a specific namespace
    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex, namespace: namespace || undefined });

    // Generate embedding for the question
    const questionEmbedding = await embeddings.embedQuery(question);
    logger.info(`Generated question embedding with length: ${questionEmbedding.length}`);

    // Search for relevant documents within the namespace
    let relevantDocs = await vectorStore.similaritySearch(question, 3);
    logger.info(`Found ${relevantDocs.length} relevant documents`);

    // If no relevant documents are found, try a direct Pinecone query
    if (relevantDocs.length === 0) {
      const queryResponse = await pineconeIndex.query({
        vector: questionEmbedding,
        topK: 10,
        includeMetadata: true,
        includeValues: true
      });
      console.log({ queryResponse });
      logger.info(`Direct Pinecone query results: ${JSON.stringify(queryResponse)}`);

      relevantDocs = queryResponse.matches.map(match => ({
        pageContent: match.metadata.pageContent,
      }));
    }

    // Check if we found any relevant documents
    if (relevantDocs.length === 0) {
      return res.json({ answer: "Sorry, I couldn't find any relevant documents to answer your question." });
    }

    // Prepare context from relevant documents
    const context = relevantDocs.map(doc => doc.pageContent).join('\n\n');

    // Generate answer using Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const prompt = `
    Context: ${context}

    Question: ${question}

    Please provide a concise and accurate answer to the question based on the given context. If the context doesn't contain enough information to answer the question, please state that.
    `;

    const result = await model.generateContent(prompt);
    const answer = result.response.text();

    logger.info('Answer generated successfully');

    res.json({ answer });
  } catch (error) {
    logger.error('Error processing question', error);
    console.error(error);
    res.status(500).json({ error: 'Error processing question', details: error.message });
  }
};

exports.uploadDoc = async (req, res) => {
  try {
    logger.info('Starting document upload process');

    const file = req.file;

    if (!file) {
      logger.error('No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileType = file.mimetype;
    logger.info(`File type: ${fileType}`);

    // Define the uploads directory
    const uploadsDir = path.join(__dirname, '../uploads');

    // Ensure the uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Create a temporary file path
    const tempFilePath = path.join(uploadsDir, file.originalname);

    // Write the file buffer to disk
    fs.writeFileSync(tempFilePath, file.buffer);

    let rawDocs;
    if (fileType === 'application/pdf') {
      const loader = new PDFLoader(tempFilePath);
      rawDocs = await loader.load();
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const loader = new DocxLoader(tempFilePath);
      rawDocs = await loader.load();
    } else {
      logger.error(`Invalid file type: ${fileType}`);
      fs.unlinkSync(tempFilePath);  // Clean up the temp file
      return res.status(400).json({ error: 'Invalid file type. Only PDF and DOCX are allowed.' });
    }

    logger.info(`Processing file: ${file.originalname}`);

    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const docs = await textSplitter.splitDocuments(rawDocs);
    logger.info(`Document split into ${docs.length} chunks`);

    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      modelName: "models/embedding-001"
    });

    const indexName = process.env.PINECONE_INDEX_NAME;
    if (!indexName) {
      throw new Error('PINECONE_INDEX_NAME is not set in environment variables');
    }

    logger.info(`Initializing Pinecone index: ${indexName}`);
    const pineconeIndex = pinecone.Index(indexName);

    logger.info('Storing documents in Pinecone');
    await PineconeStore.fromDocuments(docs, embeddings, {
      pineconeIndex,
      namespace: "euler-namespace",
    });

    // Clean up the temp file after processing
    fs.unlinkSync(tempFilePath);

    logger.info('Document processed and stored in Pinecone');
    res.json({ status: 'success', message: 'Document processed and stored' });
  } catch (error) {
    logger.error('Error processing document', error);
    console.error(error);
    res.status(500).json({ error: 'Error processing document', details: error.message });
  }
};
