import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import pool from '../config/database.js';
import { authenticateToken, authorizeRole, authenticateTokenSimple } from '../middleware/auth.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// File storage configuration
const UPLOAD_BASE_PATH = '/home/files/rms-files';

// Ensure upload directories exist
const ensureUploadDirectories = async () => {
  const directories = [
    `${UPLOAD_BASE_PATH}/documents`,
    `${UPLOAD_BASE_PATH}/documents/lease-agreements`,
    `${UPLOAD_BASE_PATH}/documents/insurance`,
    `${UPLOAD_BASE_PATH}/documents/maintenance`,
    `${UPLOAD_BASE_PATH}/documents/financial`,
    `${UPLOAD_BASE_PATH}/documents/legal`,
    `${UPLOAD_BASE_PATH}/documents/tenant-documents`,
    `${UPLOAD_BASE_PATH}/documents/property-documents`,
    `${UPLOAD_BASE_PATH}/temp`
  ];

  for (const dir of directories) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create directory ${dir}:`, error.message);
    }
  }
};

// Initialize directories on startup
ensureUploadDirectories();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const category = req.body.category || 'general';
    const categoryPath = category.toLowerCase().replace(/\s+/g, '-');
    const uploadPath = `${UPLOAD_BASE_PATH}/documents/${categoryPath}`;
    
    try {
      await fs.mkdir(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (error) {
      console.error('Upload directory creation failed:', error);
      cb(null, `${UPLOAD_BASE_PATH}/documents`);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const randomSuffix = Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, extension)
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .substring(0, 50);
    
    const filename = `${timestamp}_${randomSuffix}_${baseName}${extension}`;
    cb(null, filename);
  }
});

// File filter for allowed types
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg',
    'image/png',
    'image/gif',
    'text/plain',
    'text/csv'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 5 // Maximum 5 files per upload
  }
});

// Helper function to get file extension from mime type
const getFileExtension = (mimetype) => {
  const mimeToExt = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'text/plain': 'txt',
    'text/csv': 'csv'
  };
  return mimeToExt[mimetype] || 'unknown';
};

// Helper function to log document access
const logDocumentAccess = async (client, documentId, userId, accessType, ipAddress, userAgent) => {
  try {
    await client.query(`
      INSERT INTO document_access_log (document_id, accessed_by, access_type, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5)
    `, [documentId, userId, accessType, ipAddress, userAgent]);

    await client.query(`
      UPDATE documents 
      SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP 
      WHERE id = $1
    `, [documentId]);
  } catch (error) {
    console.error('Failed to log document access:', error);
  }
};

// GET /api/documents - Retrieve all documents with filtering and search
router.get('/', authenticateTokenSimple, async (req, res) => {
  console.log('📄 Fetching documents for user:', req.user?.id);
  
  const client = await pool.connect();
  
  try {
    const {
      category,
      search,
      property_id,
      unit_id,
      tenant_id,
      lease_id,
      tags,
      page = 1,
      limit = 20,
      sort_by = 'uploaded_at',
      sort_order = 'DESC'
    } = req.query;

    let baseQuery = `
      SELECT 
        d.*,
        dc.category_name,
        CASE 
          WHEN d.property_id IS NOT NULL THEN p.property_name
          WHEN d.unit_id IS NOT NULL THEN p2.property_name || ' - Unit ' || u.unit_number
          WHEN d.tenant_id IS NOT NULL THEN t.first_name || ' ' || t.last_name
          WHEN d.lease_id IS NOT NULL THEN 'Lease ' || l.lease_number
        END as associated_with,
        CASE 
          WHEN d.property_id IS NOT NULL THEN 'Property'
          WHEN d.unit_id IS NOT NULL THEN 'Unit'
          WHEN d.tenant_id IS NOT NULL THEN 'Tenant'
          WHEN d.lease_id IS NOT NULL THEN 'Lease'
        END as association_type
      FROM documents d
      LEFT JOIN document_categories dc ON d.category_id = dc.id
      LEFT JOIN properties p ON d.property_id = p.id
      LEFT JOIN units u ON d.unit_id = u.id
      LEFT JOIN properties p2 ON u.property_id = p2.id
      LEFT JOIN tenants t ON d.tenant_id = t.id
      LEFT JOIN leases l ON d.lease_id = l.id
      WHERE d.document_status = 'active'
    `;

    const params = [];
    let paramCount = 0;

    // Add filters
    if (category && category !== 'All') {
      paramCount++;
      baseQuery += ` AND dc.category_name = $${paramCount}`;
      params.push(category);
    }

    if (search) {
      paramCount++;
      baseQuery += ` AND (
        d.document_name ILIKE $${paramCount} OR 
        d.description ILIKE $${paramCount} OR
        d.tags::text ILIKE $${paramCount}
      )`;
      params.push(`%${search}%`);
    }

    if (property_id) {
      paramCount++;
      baseQuery += ` AND d.property_id = $${paramCount}`;
      params.push(property_id);
    }

    if (unit_id) {
      paramCount++;
      baseQuery += ` AND d.unit_id = $${paramCount}`;
      params.push(unit_id);
    }

    if (tenant_id) {
      paramCount++;
      baseQuery += ` AND d.tenant_id = $${paramCount}`;
      params.push(tenant_id);
    }

    if (lease_id) {
      paramCount++;
      baseQuery += ` AND d.lease_id = $${paramCount}`;
      params.push(lease_id);
    }

    if (tags) {
      paramCount++;
      baseQuery += ` AND d.tags && $${paramCount}`;
      params.push(`{${tags}}`);
    }

    // Add sorting
    const allowedSortFields = ['uploaded_at', 'document_name', 'file_size', 'last_accessed'];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'uploaded_at';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    baseQuery += ` ORDER BY d.${sortField} ${sortDirection}`;

    // Add pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    paramCount++;
    baseQuery += ` LIMIT $${paramCount}`;
    params.push(parseInt(limit));
    
    paramCount++;
    baseQuery += ` OFFSET $${paramCount}`;
    params.push(offset);

    const result = await client.query(baseQuery, params);

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total
      FROM documents d
      LEFT JOIN document_categories dc ON d.category_id = dc.id
      WHERE d.document_status = 'active'
    `;
    
    const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET params
    if (countParams.length > 0) {
      // Rebuild the WHERE clause for count query
      let countParamIndex = 0;
      if (category && category !== 'All') {
        countParamIndex++;
        countQuery += ` AND dc.category_name = $${countParamIndex}`;
      }
      if (search) {
        countParamIndex++;
        countQuery += ` AND (
          d.document_name ILIKE $${countParamIndex} OR 
          d.description ILIKE $${countParamIndex} OR
          d.tags::text ILIKE $${countParamIndex}
        )`;
      }
      // Add other filters as needed...
    }

    const countResult = await client.query(countQuery, countParams);
    const totalDocuments = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalDocuments / parseInt(limit));

    // Format documents for frontend
    const documents = result.rows.map(doc => ({
      id: doc.id,
      name: doc.document_name,
      type: doc.file_type.toUpperCase(),
      size: formatFileSize(doc.file_size),
      category: doc.category_name || 'Uncategorized',
      lastModified: doc.uploaded_at.toISOString().split('T')[0],
      tags: doc.tags || [],
      shared: doc.is_shared,
      important: doc.is_important,
      associatedWith: doc.associated_with,
      associationType: doc.association_type,
      accessCount: doc.access_count,
      expiresAt: doc.expires_at
    }));

    res.status(200).json({
      status: 200,
      message: 'Documents retrieved successfully',
      data: {
        documents,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalDocuments,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1
        }
      }
    });

  } catch (error) {
    console.error('❌ Error fetching documents:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch documents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// GET /api/documents/categories - Get all document categories
router.get('/categories', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const result = await client.query(`
      SELECT id, category_name, description 
      FROM document_categories 
      ORDER BY category_name
    `);

    const categories = ['All', ...result.rows.map(row => row.category_name)];

    res.status(200).json({
      status: 200,
      message: 'Categories retrieved successfully',
      data: { categories }
    });

  } catch (error) {
    console.error('❌ Error fetching categories:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch categories',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// POST /api/documents/upload - Upload new document(s)
router.post('/upload', authenticateTokenSimple, upload.array('files', 5), async (req, res) => {
  console.log('📤 Document upload initiated by user:', req.user?.id);
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const {
      document_name,
      category,
      tags,
      description,
      property_id,
      unit_id,
      tenant_id,
      lease_id,
      is_shared = false,
      is_important = false,
      expires_at
    } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        message: 'No files uploaded'
      });
    }

    // Validate that at least one association is provided
    if (!property_id && !unit_id && !tenant_id && !lease_id) {
      return res.status(400).json({
        status: 400,
        message: 'Document must be associated with a property, unit, tenant, or lease'
      });
    }

    // Get or create category
    let categoryId = null;
    if (category) {
      const categoryResult = await client.query(`
        INSERT INTO document_categories (category_name) 
        VALUES ($1) 
        ON CONFLICT (category_name) DO UPDATE SET category_name = EXCLUDED.category_name
        RETURNING id
      `, [category]);
      categoryId = categoryResult.rows[0].id;
    }

    const uploadedDocuments = [];

    for (const file of req.files) {
      const fileExtension = getFileExtension(file.mimetype);
      
      // Parse tags
      const parsedTags = tags ? tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [];

      const documentResult = await client.query(`
        INSERT INTO documents (
          document_name, 
          original_filename, 
          file_path, 
          file_size, 
          file_type, 
          mime_type,
          category_id,
          property_id,
          unit_id,
          tenant_id,
          lease_id,
          is_shared,
          is_important,
          tags,
          description,
          expires_at,
          uploaded_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id, document_name, file_size, uploaded_at
      `, [
        document_name || file.originalname,
        file.originalname,
        file.path,
        file.size,
        fileExtension,
        file.mimetype,
        categoryId,
        property_id || null,
        unit_id || null,
        tenant_id || null,
        lease_id || null,
        is_shared,
        is_important,
        parsedTags,
        description || null,
        expires_at || null,
        req.user.username || req.user.id
      ]);

      const document = documentResult.rows[0];
      
      // Log user activity
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, 
          activity_type, 
          activity_description,
          affected_resource_type,
          affected_resource_id
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        req.user.id,
        'document_upload',
        `Uploaded document: ${document.document_name}`,
        'document',
        document.id
      ]);

      uploadedDocuments.push({
        id: document.id,
        name: document.document_name,
        size: formatFileSize(document.file_size),
        uploadedAt: document.uploaded_at
      });
    }

    await client.query('COMMIT');

    res.status(201).json({
      status: 201,
      message: `Successfully uploaded ${uploadedDocuments.length} document(s)`,
      data: { documents: uploadedDocuments }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    
    // Clean up uploaded files on error
    if (req.files) {
      for (const file of req.files) {
        try {
          await fs.unlink(file.path);
        } catch (unlinkError) {
          console.error('Failed to delete uploaded file:', unlinkError);
        }
      }
    }

    console.error('❌ Document upload error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to upload document(s)',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Add these routes to your main app.js or server.js file, or to your dashboard routes

// GET /api/properties
router.get('/properties', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT id, property_name, address, property_type
        FROM properties 
        ORDER BY property_name
      `);
      res.json({ status: 200, data: result.rows });
    } catch (error) {
      console.error('Error fetching properties:', error);
      res.status(500).json({ status: 500, message: 'Failed to fetch properties' });
    } finally {
      client.release();
    }
  });
  
  // GET /api/units
  router.get('/units', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          u.id, 
          u.unit_number, 
          u.bedrooms, 
          u.bathrooms,
          p.property_name,
          u.occupancy_status
        FROM units u
        JOIN properties p ON u.property_id = p.id
        ORDER BY p.property_name, u.unit_number
      `);
      res.json({ status: 200, data: result.rows });
    } catch (error) {
      console.error('Error fetching units:', error);
      res.status(500).json({ status: 500, message: 'Failed to fetch units' });
    } finally {
      client.release();
    }
  });
  
  // GET /api/tenants
  router.get('/tenants', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          id, 
          first_name, 
          last_name, 
          email, 
          phone
        FROM tenants
        ORDER BY last_name, first_name
      `);
      res.json({ status: 200, data: result.rows });
    } catch (error) {
      console.error('Error fetching tenants:', error);
      res.status(500).json({ status: 500, message: 'Failed to fetch tenants' });
    } finally {
      client.release();
    }
  });
  


// GET /api/documents/:id/download - Download a document
router.get('/:id/download', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const documentId = req.params.id;
    console.log("📥 Downloading document ID:", documentId);
    
    const result = await client.query(`
      SELECT file_path, original_filename, mime_type, document_name, file_size
      FROM documents 
      WHERE id = $1 AND document_status = 'active'
    `, [documentId]);

    console.log("📄 Document query result:", result.rows);
    
    if (result.rows.length === 0) {
      console.log("❌ Document not found in database");
      return res.status(404).json({
        status: 404,
        message: 'Document not found'
      });
    }

    const document = result.rows[0];
    console.log("📁 Checking file path:", document.file_path);
    
    // Check if file exists
    try {
      await fs.access(document.file_path);
      console.log("✅ File exists on server");
    } catch (error) {
      console.log("❌ File not found on server:", error.message);
      return res.status(404).json({
        status: 404,
        message: 'File not found on server',
        filePath: document.file_path
      });
    }

    // Log access (but don't let it fail the download)
    try {
      await logDocumentAccess(
        client, 
        documentId, 
        req.user.username || req.user.id, 
        'download',
        req.ip,
        req.get('User-Agent')
      );
      console.log("✅ Document access logged");
    } catch (logError) {
      console.warn("⚠️ Failed to log document access:", logError.message);
      // Continue with download even if logging fails
    }

    // Set appropriate headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${document.original_filename}"`);
    res.setHeader('Content-Type', document.mime_type);
    
    // Set content length if available
    if (document.file_size) {
      res.setHeader('Content-Length', document.file_size);
    }

    console.log("📤 Starting file stream...");
    
    // Stream the file using createReadStream for better performance
    const path = await import('path');
    const { createReadStream } = await import('fs');
    
    try {
      const fileStream = createReadStream(document.file_path);
      
      fileStream.on('error', (streamError) => {
        console.error("❌ File stream error:", streamError);
        if (!res.headersSent) {
          res.status(500).json({
            status: 500,
            message: 'Error reading file',
            error: streamError.message
          });
        }
      });

      fileStream.on('end', () => {
        console.log("✅ File download completed");
      });

      // Pipe the file to the response
      fileStream.pipe(res);
      
    } catch (streamError) {
      console.error("❌ Error creating file stream:", streamError);
      if (!res.headersSent) {
        res.status(500).json({
          status: 500,
          message: 'Error streaming file',
          error: streamError.message
        });
      }
    }

  } catch (error) {
    console.error('❌ Document download error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        status: 500,
        message: 'Failed to download document',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  } finally {
    client.release();
  }
});

// Add this debug route to your backend to check file status
router.get('/:id/check', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const documentId = req.params.id;
    console.log("🔍 Checking document ID:", documentId);
    
    const result = await client.query(`
      SELECT file_path, original_filename, mime_type, document_name, file_size
      FROM documents 
      WHERE id = $1 AND document_status = 'active'
    `, [documentId]);

    if (result.rows.length === 0) {
      return res.json({
        status: 'not_found',
        message: 'Document not found in database'
      });
    }

    const document = result.rows[0];
    
    // Check if file exists
    let fileExists = false;
    let fileStats = null;
    let error = null;
    
    try {
      await fs.access(document.file_path);
      fileExists = true;
      
      // Get file stats
      const stats = await fs.stat(document.file_path);
      fileStats = {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        isFile: stats.isFile()
      };
    } catch (fsError) {
      error = fsError.message;
    }

    res.json({
      status: 'success',
      document: {
        id: documentId,
        name: document.document_name,
        original_filename: document.original_filename,
        file_path: document.file_path,
        mime_type: document.mime_type,
        db_file_size: document.file_size
      },
      file_check: {
        exists: fileExists,
        stats: fileStats,
        error: error
      }
    });

  } catch (error) {
    console.error('❌ File check error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to check file',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// GET /api/documents/:id/view - View/preview a document
router.get('/:id/view', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const documentId = req.params.id;
    
    const result = await client.query(`
      SELECT file_path, original_filename, mime_type, document_name
      FROM documents 
      WHERE id = $1 AND document_status = 'active'
    `, [documentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: 'Document not found'
      });
    }

    const document = result.rows[0];
    
    // Check if file exists
    try {
      await fs.access(document.file_path);
    } catch (error) {
      return res.status(404).json({
        status: 404,
        message: 'File not found on server'
      });
    }

    // Log access
    await logDocumentAccess(
      client, 
      documentId, 
      req.user.username || req.user.id, 
      'view',
      req.ip,
      req.get('User-Agent')
    );

    // Set appropriate headers for inline viewing
    res.setHeader('Content-Type', document.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${document.original_filename}"`);

    // Stream the file
    const fileStream = await fs.readFile(document.file_path);
    res.send(fileStream);

  } catch (error) {
    console.error('❌ Document view error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to view document',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// PUT /api/documents/:id - Update document metadata
router.put('/:id', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const documentId = req.params.id;
    const {
      document_name,
      category,
      tags,
      description,
      is_shared,
      is_important,
      expires_at
    } = req.body;

    // Get or create category if provided
    let categoryId = null;
    if (category) {
      const categoryResult = await client.query(`
        INSERT INTO document_categories (category_name) 
        VALUES ($1) 
        ON CONFLICT (category_name) DO UPDATE SET category_name = EXCLUDED.category_name
        RETURNING id
      `, [category]);
      categoryId = categoryResult.rows[0].id;
    }

    // Parse tags
    const parsedTags = tags ? (Array.isArray(tags) ? tags : tags.split(',').map(tag => tag.trim()).filter(tag => tag)) : null;

    const result = await client.query(`
      UPDATE documents 
      SET 
        document_name = COALESCE($1, document_name),
        category_id = COALESCE($2, category_id),
        tags = COALESCE($3, tags),
        description = COALESCE($4, description),
        is_shared = COALESCE($5, is_shared),
        is_important = COALESCE($6, is_important),
        expires_at = COALESCE($7, expires_at),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8 AND document_status = 'active'
      RETURNING *
    `, [
      document_name,
      categoryId,
      parsedTags,
      description,
      is_shared,
      is_important,
      expires_at,
      documentId
    ]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        status: 404,
        message: 'Document not found'
      });
    }

    // Log user activity
    await client.query(`
      INSERT INTO user_activity_log (
        user_id, 
        activity_type, 
        activity_description,
        affected_resource_type,
        affected_resource_id
      ) VALUES ($1, $2, $3, $4, $5)
    `, [
      req.user.id,
      'document_update',
      `Updated document: ${result.rows[0].document_name}`,
      'document',
      documentId
    ]);

    await client.query('COMMIT');

    res.status(200).json({
      status: 200,
      message: 'Document updated successfully',
      data: { document: result.rows[0] }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Document update error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to update document',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// DELETE /api/documents/:id - Delete a document
router.delete('/:id', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const documentId = req.params.id;

    // Get document info before deletion
    const documentResult = await client.query(`
      SELECT file_path, document_name 
      FROM documents 
      WHERE id = $1 AND document_status = 'active'
    `, [documentId]);

    if (documentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        status: 404,
        message: 'Document not found'
      });
    }

    const document = documentResult.rows[0];

    // Soft delete: update status instead of physical deletion
    await client.query(`
      UPDATE documents 
      SET document_status = 'deleted', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [documentId]);

    // Log user activity
    await client.query(`
      INSERT INTO user_activity_log (
        user_id, 
        activity_type, 
        activity_description,
        affected_resource_type,
        affected_resource_id
      ) VALUES ($1, $2, $3, $4, $5)
    `, [
      req.user.id,
      'document_delete',
      `Deleted document: ${document.document_name}`,
      'document',
      documentId
    ]);

    await client.query('COMMIT');

    // Optional: Move file to trash directory instead of deleting
    try {
      const trashPath = `${UPLOAD_BASE_PATH}/trash`;
      await fs.mkdir(trashPath, { recursive: true });
      
      const fileName = path.basename(document.file_path);
      const trashFilePath = path.join(trashPath, `${Date.now()}_${fileName}`);
      await fs.rename(document.file_path, trashFilePath);
    } catch (fileError) {
      console.error('Failed to move file to trash:', fileError);
      // Continue anyway - the database record is already marked as deleted
    }

    res.status(200).json({
      status: 200,
      message: 'Document deleted successfully'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Document deletion error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to delete document',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// GET /api/documents/stats - Get document statistics
router.get('/stats', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_documents,
        COUNT(CASE WHEN uploaded_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as recent_uploads,
        SUM(file_size) as total_size,
        COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_DATE + INTERVAL '30 days' THEN 1 END) as expiring_soon,
        COUNT(CASE WHEN is_important = true THEN 1 END) as important_documents
      FROM documents 
      WHERE document_status = 'active'
    `;

    const categoryStatsQuery = `
      SELECT 
        dc.category_name,
        COUNT(d.id) as document_count
      FROM document_categories dc
      LEFT JOIN documents d ON dc.id = d.category_id AND d.document_status = 'active'
      GROUP BY dc.id, dc.category_name
      ORDER BY document_count DESC
    `;

    const [statsResult, categoryResult] = await Promise.all([
      client.query(statsQuery),
      client.query(categoryStatsQuery)
    ]);

    const stats = statsResult.rows[0];
    const categoryStats = categoryResult.rows;

    res.status(200).json({
      status: 200,
      message: 'Document statistics retrieved successfully',
      data: {
        totalDocuments: parseInt(stats.total_documents),
        recentUploads: parseInt(stats.recent_uploads),
        totalSize: formatFileSize(parseInt(stats.total_size || 0)),
        expiringSoon: parseInt(stats.expiring_soon),
        importantDocuments: parseInt(stats.important_documents),
        categoryStats
      }
    });

  } catch (error) {
    console.error('❌ Error fetching document statistics:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch document statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Utility function to format file size
const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
};

router.get('/leases', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          l.id,
          l.lease_number,
          l.lease_status,
          l.start_date,
          l.end_date,
          p.property_name,
          u.unit_number,
          STRING_AGG(t.first_name || ' ' || t.last_name, ', ') as tenant_names
        FROM leases l
        JOIN units u ON l.unit_id = u.id
        JOIN properties p ON u.property_id = p.id
        LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
        LEFT JOIN tenants t ON lt.tenant_id = t.id
        WHERE l.lease_status IN ('active', 'draft')
        GROUP BY l.id, l.lease_number, l.lease_status, l.start_date, l.end_date, p.property_name, u.unit_number
        ORDER BY l.lease_number
      `);
  
      res.status(200).json({
        status: 200,
        message: 'Leases retrieved successfully',
        data: result.rows
      });
  
    } catch (error) {
      console.error('❌ Error fetching leases:', error);
      res.status(500).json({
        status: 500,
        message: 'Failed to fetch leases',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });

export default router;