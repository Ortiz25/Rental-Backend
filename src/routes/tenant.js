import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';


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

/**
 * Safely converts a value to a number, returning null for empty/invalid values
 */
const safeParseFloat = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
};

/**
 * Safely converts a value to an integer, returning null for empty/invalid values
 */
const safeParseInt = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = parseInt(value);
  return isNaN(parsed) ? null : parsed;
};

/**
 * Safely processes a string value, returning null for empty strings
 */
const safeString = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return typeof value === "string" ? value.trim() : String(value).trim();
};

/**
 * Safely processes a date string, returning null for empty values
 */
const safeDate = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return typeof value === "string" ? value.trim() : value;
};

router.get(
  "/blacklist-categories",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const result = await client.query(
        "SELECT * FROM blacklist_categories WHERE is_active = true ORDER BY category_name"
      );

      res.status(200).json({
        status: 200,
        message: "Blacklist categories retrieved successfully",
        data: result.rows,
      });
    } catch (error) {
      console.error("Blacklist categories fetch error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to fetch blacklist categories",
      });
    } finally {
      client.release();
    }
  }
);

// GET /api/tenants/:id/offboarding-info - Get offboarding details for a tenant
router.get("/:id/offboarding-info", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.id;

    // Get offboarding details from user_activity_log
    const query = `
      SELECT 
        additional_data,
        activity_timestamp,
        user_id
      FROM user_activity_log
      WHERE affected_resource_id = $1
        AND activity_type = 'tenant_offboarded'
      ORDER BY activity_timestamp DESC
      LIMIT 1
    `;

    const result = await client.query(query, [tenantId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "No offboarding information found",
      });
    }

    const offboardingRecord = result.rows[0];
    
    // Get username of who processed the offboarding
    const userQuery = `SELECT username FROM users WHERE id = $1`;
    const userResult = await client.query(userQuery, [offboardingRecord.user_id]);
    
    const offboardingData = {
      ...offboardingRecord.additional_data,
      processedBy: userResult.rows[0]?.username,
      offboardedAt: offboardingRecord.activity_timestamp
    };

    res.status(200).json({
      status: 200,
      message: "Offboarding information retrieved successfully",
      data: offboardingData,
    });
  } catch (error) {
    console.error("Offboarding info fetch error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch offboarding information",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get all blacklisted tenants
router.get("/blacklisted/list", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const { severity, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = "WHERE t.is_blacklisted = true";
    const queryParams = [];
    let paramCount = 0;

    if (severity) {
      paramCount++;
      whereClause += ` AND t.blacklist_severity = $${paramCount}`;
      queryParams.push(severity);
    }

    const blacklistedQuery = `
      SELECT 
        t.id,
        t.first_name,
        t.last_name,
        t.email,
        t.phone,
        t.blacklist_reason,
        t.blacklist_severity,
        t.blacklisted_date,
        t.blacklisted_by,
        t.blacklist_notes,
        
        -- Current property info if any
        p.property_name,
        u.unit_number,
        l.lease_status,
        
        -- Count of blacklist history entries
        (SELECT COUNT(*) FROM tenant_blacklist_history WHERE tenant_id = t.id) as history_count
        
      FROM tenants t
      LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
      LEFT JOIN leases l ON lt.lease_id = l.id
      LEFT JOIN units u ON l.unit_id = u.id
      LEFT JOIN properties p ON u.property_id = p.id
      ${whereClause}
      ORDER BY t.blacklisted_date DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    queryParams.push(limit, offset);

    const result = await client.query(blacklistedQuery, queryParams);

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM tenants t ${whereClause}`;
    const countResult = await client.query(
      countQuery,
      queryParams.slice(0, paramCount)
    );

    res.status(200).json({
      status: 200,
      message: "Blacklisted tenants retrieved successfully",
      data: {
        tenants: result.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(countResult.rows[0].total / limit),
        },
      },
    });
  } catch (error) {
    console.error("Blacklisted tenants fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch blacklisted tenants",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});
router.get(
  "/blacklist-analytics",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      // Get basic stats
      const statsQuery = `
      SELECT 
        COUNT(*) as total_blacklisted,
        COUNT(CASE WHEN blacklisted_date > CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as recent_blacklists,
        COUNT(CASE WHEN blacklist_severity = 'low' THEN 1 END) as low_severity,
        COUNT(CASE WHEN blacklist_severity = 'medium' THEN 1 END) as medium_severity,
        COUNT(CASE WHEN blacklist_severity = 'high' THEN 1 END) as high_severity,
        COUNT(CASE WHEN blacklist_severity = 'severe' THEN 1 END) as severe_cases
      FROM tenants 
      WHERE is_blacklisted = true
    `;

      const statsResult = await client.query(statsQuery);
      const stats = statsResult.rows[0];

      // Get common reasons
      const reasonsQuery = `
      SELECT 
        blacklist_reason as reason,
        COUNT(*) as count
      FROM tenants 
      WHERE is_blacklisted = true AND blacklist_reason IS NOT NULL
      GROUP BY blacklist_reason
      ORDER BY count DESC
      LIMIT 10
    `;

      const reasonsResult = await client.query(reasonsQuery);

      // Get monthly trends (last 12 months)
      const trendsQuery = `
      SELECT 
        TO_CHAR(blacklisted_date, 'YYYY-MM') as month,
        COUNT(*) as count
      FROM tenants 
      WHERE is_blacklisted = true 
        AND blacklisted_date > CURRENT_DATE - INTERVAL '12 months'
      GROUP BY TO_CHAR(blacklisted_date, 'YYYY-MM')
      ORDER BY month
    `;

      const trendsResult = await client.query(trendsQuery);

      // Get prevented applications count
      const preventedQuery = `
      SELECT COUNT(*) as prevented
      FROM user_activity_log 
      WHERE activity_type = 'blacklisted_application_blocked'
        AND activity_timestamp > CURRENT_DATE - INTERVAL '30 days'
    `;

      const preventedResult = await client.query(preventedQuery);

      // Format response
      const analyticsData = {
        totalBlacklisted: parseInt(stats.total_blacklisted),
        recentBlacklists: parseInt(stats.recent_blacklists),
        preventedApplications: parseInt(preventedResult.rows[0].prevented),

        severityBreakdown: {
          low: parseInt(stats.low_severity),
          medium: parseInt(stats.medium_severity),
          high: parseInt(stats.high_severity),
          severe: parseInt(stats.severe_cases),
        },

        commonReasons: reasonsResult.rows,

        monthlyTrends: trendsResult.rows.map((row) => ({
          month: row.month,
          count: parseInt(row.count),
        })),
      };

      res.status(200).json({
        status: 200,
        message: "Blacklist analytics retrieved successfully",
        data: analyticsData,
      });
    } catch (error) {
      console.error("Blacklist analytics error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to fetch blacklist analytics",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// POST /api/documents/tenant/upload - Upload tenant-specific document
router.post('/tenant/upload', authenticateTokenSimple, upload.array('files', 5), async (req, res) => {
  console.log('📤 Tenant document upload initiated by user:', req.user?.id);
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const {
      document_name,
      category, // This will be document_type for tenant_documents
      description,
      tenant_id
    } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        message: 'No files uploaded'
      });
    }

    if (!tenant_id) {
      return res.status(400).json({
        status: 400,
        message: 'Tenant ID is required'
      });
    }

    const uploadedDocuments = [];

    for (const file of req.files) {
      // Insert into tenant_documents table
      const documentResult = await client.query(`
        INSERT INTO tenant_documents (
          tenant_id,
          document_type,
          document_name,
          file_path,
          file_size,
          mime_type,
          uploaded_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, document_name, file_size, upload_date
      `, [
        tenant_id,
        category,
        document_name || file.originalname,
        file.path,
        file.size,
        file.mimetype,
        req.user.username || req.user.id
      ]);

      const document = documentResult.rows[0];
      
      // Also insert into main documents table for unified access
      await client.query(`
        INSERT INTO documents (
          document_name, 
          original_filename, 
          file_path, 
          file_size, 
          file_type, 
          mime_type,
          tenant_id,
          uploaded_by,
          tags
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        document_name || file.originalname,
        file.originalname,
        file.path,
        file.size,
        getFileExtension(file.mimetype),
        file.mimetype,
        tenant_id,
        req.user.username || req.user.id,
        [category, 'tenant-document']
      ]);

      uploadedDocuments.push({
        id: document.id,
        name: document.document_name,
        size: formatFileSize(document.file_size),
        uploadedAt: document.upload_date
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

    console.error('❌ Tenant document upload error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to upload document(s)',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get blacklist categories

router.post("/screen-applicant", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({
        status: 400,
        message: "Email or phone number required for screening",
      });
    }

    // Check for blacklisted status
    let screeningQuery = `
      SELECT 
        t.id,
        t.first_name,
        t.last_name,
        t.email,
        t.phone,
        t.is_blacklisted,
        t.blacklist_reason,
        t.blacklist_severity,
        t.blacklisted_date,
        t.blacklisted_by,
        
        -- Previous lease history
        COUNT(DISTINCT l.id) as total_leases,
        COUNT(DISTINCT CASE WHEN l.lease_status = 'terminated' THEN l.id END) as terminated_leases,
        
        -- Payment history
        COUNT(DISTINCT CASE WHEN rp.payment_status = 'overdue' THEN rp.id END) as overdue_payments,
        AVG(CASE WHEN rp.payment_status = 'paid' AND rp.payment_date > rp.due_date 
            THEN EXTRACT(DAY FROM rp.payment_date - rp.due_date) 
            ELSE 0 END) as avg_late_days
        
      FROM tenants t
      LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id
      LEFT JOIN leases l ON lt.lease_id = l.id
      LEFT JOIN rent_payments rp ON l.id = rp.lease_id
      WHERE t.email = $1 OR t.phone = $2
      GROUP BY t.id, t.first_name, t.last_name, t.email, t.phone, t.is_blacklisted, 
               t.blacklist_reason, t.blacklist_severity, t.blacklisted_date, t.blacklisted_by
    `;

    const result = await client.query(screeningQuery, [email, phone]);

    let screeningResult = {
      found: result.rows.length > 0,
      isBlacklisted: false,
      recommendation: "approve",
      recommendationReason: "No previous rental history found - new applicant",
      riskScore: 0,
    };

    if (result.rows.length > 0) {
      const tenant = result.rows[0];

      screeningResult = {
        found: true,
        tenantId: tenant.id,
        name: `${tenant.first_name} ${tenant.last_name}`,
        email: tenant.email,
        phone: tenant.phone,
        isBlacklisted: tenant.is_blacklisted,
        blacklistReason: tenant.blacklist_reason,
        blacklistSeverity: tenant.blacklist_severity,
        blacklistedDate: tenant.blacklisted_date,
        blacklistedBy: tenant.blacklisted_by,

        // Rental history
        totalLeases: parseInt(tenant.total_leases) || 0,
        terminatedLeases: parseInt(tenant.terminated_leases) || 0,
        overduePayments: parseInt(tenant.overdue_payments) || 0,
        avgLateDays: parseFloat(tenant.avg_late_days) || 0,
      };

      // Calculate risk score and recommendation
      let riskScore = 0;
      let reasons = [];

      if (tenant.is_blacklisted) {
        riskScore +=
          tenant.blacklist_severity === "severe"
            ? 100
            : tenant.blacklist_severity === "high"
              ? 80
              : tenant.blacklist_severity === "medium"
                ? 60
                : 40;
        reasons.push(`Blacklisted: ${tenant.blacklist_reason}`);
      }

      if (tenant.overdue_payments > 5) {
        riskScore += 30;
        reasons.push(`${tenant.overdue_payments} overdue payments`);
      }

      if (tenant.avg_late_days > 10) {
        riskScore += 20;
        reasons.push(`Average ${tenant.avg_late_days} days late on payments`);
      }

      if (tenant.terminated_leases > 0) {
        riskScore += 25;
        reasons.push(`${tenant.terminated_leases} terminated leases`);
      }

      // Positive factors
      if (tenant.total_leases > 0 && tenant.overdue_payments === 0) {
        riskScore -= 10;
        reasons.push("Good payment history");
      }

      screeningResult.riskScore = Math.max(0, riskScore);

      // Determine recommendation
      if (tenant.is_blacklisted && tenant.blacklist_severity === "severe") {
        screeningResult.recommendation = "reject";
        screeningResult.recommendationReason =
          "Tenant is severely blacklisted - DO NOT APPROVE";
      } else if (tenant.is_blacklisted) {
        screeningResult.recommendation = "reject";
        screeningResult.recommendationReason = `Blacklisted tenant: ${tenant.blacklist_reason}`;
      } else if (riskScore >= 50) {
        screeningResult.recommendation = "review";
        screeningResult.recommendationReason = `High risk score (${riskScore}). Issues: ${reasons.join(", ")}`;
      } else if (riskScore >= 25) {
        screeningResult.recommendation = "review";
        screeningResult.recommendationReason = `Medium risk. Review: ${reasons.join(", ")}`;
      } else {
        screeningResult.recommendation = "approve";
        screeningResult.recommendationReason =
          tenant.total_leases > 0
            ? "Good rental history - approved"
            : "No negative history found - approved";
      }

      screeningResult.riskFactors = reasons;
    }

    // Log screening activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent, additional_data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.user.id,
        "applicant_screened",
        `Screened applicant: ${email}`,
        req.ip,
        req.headers["user-agent"],
        JSON.stringify(screeningResult),
      ]
    );

    res.status(200).json({
      status: 200,
      message: "Applicant screening completed",
      data: screeningResult,
    });
  } catch (error) {
    console.error("Applicant screening error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to screen applicant",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get available properties and units for onboarding
router.get(
  "/onboarding/available-units",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      console.log("Fetching available units for tenant onboarding");

      // Get properties with available units
      const propertiesQuery = `
       SELECT 
    p.id as property_id, 
    p.property_name, 
    p.address, 
    p.property_type, 
    p.total_units, 
    p.monthly_rent as base_monthly_rent, 
    p.security_deposit as base_security_deposit,
    
    -- Count available units (with DISTINCT to avoid duplicates from amenities JOIN)
    COUNT(DISTINCT CASE WHEN u.occupancy_status = 'vacant' THEN u.id END) as available_units,
    COUNT(DISTINCT u.id) as actual_units,
    
    -- Get amenities
    COALESCE(
        JSON_AGG(DISTINCT a.name ORDER BY a.name) FILTER (WHERE a.name IS NOT NULL), 
        '[]'::json
    ) as amenities
    
FROM properties p 
LEFT JOIN units u ON p.id = u.property_id 
LEFT JOIN property_amenities pa ON p.id = pa.property_id 
LEFT JOIN amenities a ON pa.amenity_id = a.id 

GROUP BY p.id, p.property_name, p.address, p.property_type, p.total_units, p.monthly_rent, p.security_deposit 
HAVING COUNT(DISTINCT CASE WHEN u.occupancy_status = 'vacant' THEN u.id END) > 0 
ORDER BY p.property_name
      `;

      const propertiesResult = await client.query(propertiesQuery);

      // Get detailed unit information for each property
      const unitsQuery = `
        SELECT 
          u.id as unit_id,
          u.property_id,
          u.unit_number,
          u.bedrooms,
          u.bathrooms,
          u.size_sq_ft,
          u.monthly_rent,
          u.security_deposit,
          u.occupancy_status,
          
          -- Property information
          p.property_name,
          p.property_type,
          
          -- Check if there are any pending lease applications for this unit
          (
            SELECT COUNT(*) 
            FROM leases l 
            WHERE l.unit_id = u.id 
            AND l.lease_status = 'draft'
          ) as pending_applications
          
        FROM units u
        JOIN properties p ON u.property_id = p.id
        WHERE u.occupancy_status = 'vacant'
        ORDER BY p.property_name, u.unit_number
      `;

      const unitsResult = await client.query(unitsQuery);

      // Group units by property
      const unitsByProperty = {};
      unitsResult.rows.forEach((unit) => {
        if (!unitsByProperty[unit.property_id]) {
          unitsByProperty[unit.property_id] = [];
        }
        unitsByProperty[unit.property_id].push({
          id: unit.unit_id,
          unitNumber: unit.unit_number,
          bedrooms: unit.bedrooms,
          bathrooms: unit.bathrooms,
          sizeSquareFt: unit.size_sq_ft,
          monthlyRent: parseFloat(unit.monthly_rent) || 0,
          securityDeposit: parseFloat(unit.security_deposit) || 0,
          occupancyStatus: unit.occupancy_status,
          pendingApplications: parseInt(unit.pending_applications) || 0,
        });
      });

      // Format properties with their available units
      const formattedProperties = propertiesResult.rows.map((property) => ({
        id: property.property_id,
        propertyName: property.property_name,
        address: property.address,
        propertyType: property.property_type,
        totalUnits: property.total_units,
        availableUnits: parseInt(property.available_units),
        actualUnits: parseInt(property.actual_units),
        baseMonthlyRent: parseFloat(property.base_monthly_rent) || 0,
        baseSecurityDeposit: parseFloat(property.base_security_deposit) || 0,
        amenities: property.amenities || [],
        units: unitsByProperty[property.property_id] || [],
      }));

      res.status(200).json({
        status: 200,
        message: "Available units retrieved successfully",
        data: {
          properties: formattedProperties,
          totalAvailableUnits: unitsResult.rows.length,
        },
      });
    } catch (error) {
      console.error("Available units fetch error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to fetch available units",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Get specific unit details for lease creation
router.get(
  "/onboarding/units/:unitId/details",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const unitId = req.params.unitId;

      const unitQuery = `
        SELECT 
          u.id as unit_id,
          u.unit_number,
          u.bedrooms,
          u.bathrooms,
          u.size_sq_ft,
          u.monthly_rent,
          u.security_deposit,
          u.occupancy_status,
          
          -- Property details
          p.id as property_id,
          p.property_name,
          p.address,
          p.property_type,
          p.description,
          
          -- Property amenities
          COALESCE(
            JSON_AGG(
              DISTINCT a.name 
              ORDER BY a.name
            ) FILTER (WHERE a.name IS NOT NULL), 
            '[]'::json
          ) as amenities,
          
          -- Unit utilities
          COALESCE(
            JSON_AGG(
              DISTINCT ut.name 
              ORDER BY ut.name
            ) FILTER (WHERE ut.name IS NOT NULL AND uu.included = true), 
            '[]'::json
          ) as included_utilities
          
        FROM units u
        JOIN properties p ON u.property_id = p.id
        LEFT JOIN property_amenities pa ON p.id = pa.property_id
        LEFT JOIN amenities a ON pa.amenity_id = a.id
        LEFT JOIN unit_utilities uu ON u.id = uu.unit_id
        LEFT JOIN utilities ut ON uu.utility_id = ut.id
        WHERE u.id = $1
        GROUP BY u.id, u.unit_number, u.bedrooms, u.bathrooms, u.size_sq_ft, 
                 u.monthly_rent, u.security_deposit, u.occupancy_status,
                 p.id, p.property_name, p.address, p.property_type, p.description
      `;

      const result = await client.query(unitQuery, [unitId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Unit not found",
        });
      }

      const unit = result.rows[0];

      // Check if unit is available
      if (unit.occupancy_status !== "vacant") {
        return res.status(400).json({
          status: 400,
          message: "Unit is not available for lease",
        });
      }

      res.status(200).json({
        status: 200,
        message: "Unit details retrieved successfully",
        data: {
          unitId: unit.unit_id,
          unitNumber: unit.unit_number,
          bedrooms: unit.bedrooms,
          bathrooms: unit.bathrooms,
          sizeSquareFt: unit.size_sq_ft,
          monthlyRent: parseFloat(unit.monthly_rent) || 0,
          securityDeposit: parseFloat(unit.security_deposit) || 0,
          occupancyStatus: unit.occupancy_status,
          property: {
            id: unit.property_id,
            name: unit.property_name,
            address: unit.address,
            type: unit.property_type,
            description: unit.description,
          },
          amenities: unit.amenities || [],
          includedUtilities: unit.included_utilities || [],
        },
      });
    } catch (error) {
      console.error("Unit details fetch error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to fetch unit details",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Reserve unit temporarily during onboarding process
router.post(
  "/onboarding/units/:unitId/reserve",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const unitId = req.params.unitId;
      const { tenantEmail, reservationNotes } = req.body;

      // Check if unit is available
      const unitCheck = await client.query(
        "SELECT id, occupancy_status FROM units WHERE id = $1",
        [unitId]
      );

      if (unitCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Unit not found",
        });
      }

      if (unitCheck.rows[0].occupancy_status !== "vacant") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Unit is not available for reservation",
        });
      }

      // Create a draft lease as a reservation
      const reservationQuery = `
        INSERT INTO leases (
          unit_id, lease_status, start_date, monthly_rent, 
          security_deposit, lease_terms, created_at
        ) 
        SELECT 
          u.id,
          'draft',
          CURRENT_DATE + INTERVAL '7 days', -- Tentative start date
          u.monthly_rent,
          u.security_deposit,
          $1,
          CURRENT_TIMESTAMP
        FROM units u 
        WHERE u.id = $2
        RETURNING id, lease_number
      `;

      const reservationResult = await client.query(reservationQuery, [
        `Temporary reservation for ${tenantEmail}. ${reservationNotes || ""}`,
        unitId,
      ]);

      // Log the reservation
      await client.query(
        `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user.id,
          "unit_reserved",
          `Reserved unit for tenant onboarding: ${tenantEmail}`,
          "unit",
          unitId,
          req.ip,
          req.headers["user-agent"],
        ]
      );

      await client.query("COMMIT");

      res.status(200).json({
        status: 200,
        message: "Unit reserved successfully",
        data: {
          reservationId: reservationResult.rows[0].id,
          leaseNumber: reservationResult.rows[0].lease_number,
          unitId: unitId,
          reservedFor: tenantEmail,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Unit reservation error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to reserve unit",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Enhanced tenant creation route with unit allocation
// Enhanced tenant creation route with unit allocation
router.post("/onboard-with-unit", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // MOVE variable declarations to the beginning, BEFORE blacklist check
    const {
      // Tenant information
      firstName,
      lastName,
      email,
      phone,
      alternatePhone,
      dateOfBirth,
      identificationType,
      identificationNumber,
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelationship,
      employmentStatus,
      employerName,
      monthlyIncome,
      previousAddress,

      // Unit and lease information
      selectedUnitId,
      leaseStart,
      leaseEnd,
      leaseType = "Fixed Term",
      customMonthlyRent, // Optional: override unit's default rent
      customSecurityDeposit, // Optional: override unit's default deposit
      petDeposit = 0,
      lateFee = 0,
      gracePeriodDays = 5,
      rentDueDay = 1,
      leaseTerms,
      specialConditions,
      moveInDate,

      // Co-tenants (optional)
      coTenants = [], // Array of additional tenant information

      // Reservation ID (if unit was previously reserved)
      reservationId,
    } = req.body;

    // NOW perform blacklist check AFTER variables are declared
    const blacklistCheck = await client.query(
      `SELECT 
        id, first_name, last_name, is_blacklisted, blacklist_reason, blacklist_severity
       FROM tenants 
       WHERE (email = $1 OR phone = $2) AND is_blacklisted = true`,
      [email, phone]
    );

    if (blacklistCheck.rows.length > 0) {
      const blacklistedTenant = blacklistCheck.rows[0];

      await client.query("ROLLBACK");

      // Log attempted application by blacklisted tenant
      await client.query(
        `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, ip_address, user_agent, additional_data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.user.id,
          "blacklisted_application_blocked",
          `Blocked application attempt by blacklisted tenant: ${email}`,
          req.ip,
          req.headers["user-agent"],
          JSON.stringify({
            email,
            phone,
            blacklistReason: blacklistedTenant.blacklist_reason,
            blacklistSeverity: blacklistedTenant.blacklist_severity,
          }),
        ]
      );

      return res.status(403).json({
        status: 403,
        message: "Application rejected: Applicant is blacklisted",
        error: {
          type: "BLACKLISTED_TENANT",
          tenantName: `${blacklistedTenant.first_name} ${blacklistedTenant.last_name}`,
          reason: blacklistedTenant.blacklist_reason,
          severity: blacklistedTenant.blacklist_severity,
        },
      });
    }

    // Validate required fields
    if (!firstName || !lastName || !email || !selectedUnitId || !leaseStart) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message:
          "Required fields: firstName, lastName, email, selectedUnitId, leaseStart",
      });
    }

    // Check if email already exists
    const emailCheck = await client.query(
      "SELECT id FROM tenants WHERE email = $1",
      [email]
    );

    if (emailCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: "Email already exists",
      });
    }

    // Get unit details and verify availability
    const unitQuery = `
        SELECT 
          u.id, u.unit_number, u.monthly_rent, u.security_deposit, u.occupancy_status,
          p.id as property_id, p.property_name, p.address
        FROM units u
        JOIN properties p ON u.property_id = p.id
        WHERE u.id = $1
      `;

    const unitResult = await client.query(unitQuery, [selectedUnitId]);

    if (unitResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Selected unit not found",
      });
    }

    const selectedUnit = unitResult.rows[0];

    // Check if unit is available (unless it's reserved by this process)
    if (selectedUnit.occupancy_status !== "vacant") {
      // Check if there's a valid reservation
      if (reservationId) {
        const reservationCheck = await client.query(
          "SELECT id FROM leases WHERE id = $1 AND unit_id = $2 AND lease_status = $3",
          [reservationId, selectedUnitId, "draft"]
        );

        if (reservationCheck.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            status: 400,
            message: "Unit reservation not found or expired",
          });
        }
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Selected unit is not available",
        });
      }
    }

    // Create primary tenant
    const tenantQuery = `
        INSERT INTO tenants (
          first_name, last_name, email, phone, alternate_phone,
          date_of_birth, identification_type, identification_number,
          emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
          employment_status, employer_name, monthly_income, previous_address
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `;

    // Handle empty strings for numeric and date fields
    const processedMonthlyIncome =
      monthlyIncome && monthlyIncome.toString().trim() !== ""
        ? parseFloat(monthlyIncome)
        : null;

    const processedDateOfBirth =
      dateOfBirth && dateOfBirth.trim() !== "" ? dateOfBirth : null;

    const tenantResult = await client.query(tenantQuery, [
      firstName,
      lastName,
      email,
      phone,
      alternatePhone || null,
      processedDateOfBirth,
      identificationType || null,
      identificationNumber || null,
      emergencyContactName || null,
      emergencyContactPhone || null,
      emergencyContactRelationship || null,
      employmentStatus || null,
      employerName || null,
      processedMonthlyIncome,
      previousAddress || null,
    ]);

    const primaryTenant = tenantResult.rows[0];

    // Determine lease amounts (use custom amounts if provided, otherwise use unit defaults)
    const finalMonthlyRent =
      customMonthlyRent && customMonthlyRent.toString().trim() !== ""
        ? parseFloat(customMonthlyRent)
        : parseFloat(selectedUnit.monthly_rent);

    const finalSecurityDeposit =
      customSecurityDeposit && customSecurityDeposit.toString().trim() !== ""
        ? parseFloat(customSecurityDeposit)
        : parseFloat(selectedUnit.security_deposit);

    // Process other numeric fields
    const processedPetDeposit =
      petDeposit && petDeposit.toString().trim() !== ""
        ? parseFloat(petDeposit)
        : 0;

    const processedLateFee =
      lateFee && lateFee.toString().trim() !== "" ? parseFloat(lateFee) : 0;

    const processedGracePeriodDays =
      gracePeriodDays && gracePeriodDays.toString().trim() !== ""
        ? parseInt(gracePeriodDays)
        : 5;

    const processedRentDueDay =
      rentDueDay && rentDueDay.toString().trim() !== ""
        ? parseInt(rentDueDay)
        : 1;

    // Create or update lease
    let leaseId;
    if (reservationId) {
      // Update the existing draft lease
      const updateLeaseQuery = `
          UPDATE leases SET 
            lease_status = 'active',
            lease_type = $1,
            start_date = $2,
            end_date = $3,
            monthly_rent = $4,
            security_deposit = $5,
            pet_deposit = $6,
            late_fee = $7,
            grace_period_days = $8,
            rent_due_day = $9,
            lease_terms = $10,
            special_conditions = $11,
            signed_date = CURRENT_DATE,
            move_in_date = $12,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $13
          RETURNING *
        `;

      const leaseResult = await client.query(updateLeaseQuery, [
        leaseType,
        leaseStart,
        leaseEnd,
        finalMonthlyRent,
        finalSecurityDeposit,
        processedPetDeposit,
        processedLateFee,
        processedGracePeriodDays,
        processedRentDueDay,
        leaseTerms,
        specialConditions,
        moveInDate,
        reservationId,
      ]);

      leaseId = reservationId;
    } else {
      // Create new lease
      const createLeaseQuery = `
          INSERT INTO leases (
            unit_id, lease_type, lease_status, start_date, end_date, monthly_rent,
            security_deposit, pet_deposit, late_fee, grace_period_days, rent_due_day,
            lease_terms, special_conditions, signed_date, move_in_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING *
        `;

      const leaseResult = await client.query(createLeaseQuery, [
        selectedUnitId,
        leaseType,
        "active",
        leaseStart,
        leaseEnd,
        finalMonthlyRent,
        finalSecurityDeposit,
        processedPetDeposit,
        processedLateFee,
        processedGracePeriodDays,
        processedRentDueDay,
        leaseTerms,
        specialConditions,
        new Date(),
        moveInDate,
      ]);

      leaseId = leaseResult.rows[0].id;
    }

    // Link primary tenant to lease
    await client.query(
      "INSERT INTO lease_tenants (lease_id, tenant_id, is_primary_tenant, tenant_type) VALUES ($1, $2, $3, $4)",
      [leaseId, primaryTenant.id, true, "Tenant"]
    );

    // Add co-tenants if provided
    const coTenantIds = [];
    for (const coTenant of coTenants) {
      // Check if co-tenant email already exists
      const coTenantEmailCheck = await client.query(
        "SELECT id FROM tenants WHERE email = $1",
        [coTenant.email]
      );

      let coTenantId;
      if (coTenantEmailCheck.rows.length > 0) {
        // Use existing tenant
        coTenantId = coTenantEmailCheck.rows[0].id;
      } else {
        // Process co-tenant data same way as primary tenant
        const coTenantProcessedMonthlyIncome =
          coTenant.monthlyIncome &&
          coTenant.monthlyIncome.toString().trim() !== ""
            ? parseFloat(coTenant.monthlyIncome)
            : null;

        const coTenantProcessedDateOfBirth =
          coTenant.dateOfBirth && coTenant.dateOfBirth.trim() !== ""
            ? coTenant.dateOfBirth
            : null;

        // Create new co-tenant
        const coTenantResult = await client.query(tenantQuery, [
          coTenant.firstName,
          coTenant.lastName,
          coTenant.email,
          coTenant.phone,
          coTenant.alternatePhone || null,
          coTenantProcessedDateOfBirth,
          coTenant.identificationType || null,
          coTenant.identificationNumber || null,
          coTenant.emergencyContactName || null,
          coTenant.emergencyContactPhone || null,
          coTenant.emergencyContactRelationship || null,
          coTenant.employmentStatus || null,
          coTenant.employerName || null,
          coTenantProcessedMonthlyIncome,
          coTenant.previousAddress || null,
        ]);
        coTenantId = coTenantResult.rows[0].id;
      }

      // Link co-tenant to lease
      await client.query(
        "INSERT INTO lease_tenants (lease_id, tenant_id, is_primary_tenant, tenant_type) VALUES ($1, $2, $3, $4)",
        [leaseId, coTenantId, false, coTenant.tenantType || "Co-Tenant"]
      );

      coTenantIds.push(coTenantId);
    }

    // Update unit status to occupied
    await client.query(
      "UPDATE units SET occupancy_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      ["occupied", selectedUnitId]
    );

    // Create security deposit record
    await client.query(
      `INSERT INTO security_deposits (
          lease_id, deposit_type, amount_collected, collection_date, status
        ) VALUES ($1, $2, $3, $4, $5)`,
      [
        leaseId,
        "Security",
        finalSecurityDeposit,
        moveInDate || leaseStart,
        "held",
      ]
    );

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        "tenant_onboarded_with_unit",
        `Onboarded tenant: ${firstName} ${lastName} to ${selectedUnit.property_name} Unit ${selectedUnit.unit_number}`,
        "tenant",
        primaryTenant.id,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      status: 201,
      message: "Tenant onboarded successfully with unit allocation",
      data: {
        tenant: primaryTenant,
        coTenants: coTenantIds,
        lease: {
          id: leaseId,
          unitId: selectedUnitId,
          unitNumber: selectedUnit.unit_number,
          propertyName: selectedUnit.property_name,
          monthlyRent: finalMonthlyRent,
          securityDeposit: finalSecurityDeposit,
          leaseStart,
          leaseEnd,
          moveInDate,
        },
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Tenant onboarding with unit allocation error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to onboard tenant with unit allocation",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Search tenants
router.get("/search/:query", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const searchQuery = req.params.query;

    const tenantsQuery = `
        SELECT 
          t.id,
          t.first_name,
          t.last_name,
          t.email,
          t.phone,
          p.property_name,
          u.unit_number,
          l.lease_status
        FROM tenants t
        LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
        LEFT JOIN leases l ON lt.lease_id = l.id
        LEFT JOIN units u ON l.unit_id = u.id
        LEFT JOIN properties p ON u.property_id = p.id
        WHERE 
          t.first_name ILIKE $1 OR 
          t.last_name ILIKE $1 OR 
          t.email ILIKE $1 OR
          p.property_name ILIKE $1 OR
          u.unit_number ILIKE $1
        ORDER BY t.first_name, t.last_name
      `;

    const result = await client.query(tenantsQuery, [`%${searchQuery}%`]);

    res.status(200).json({
      status: 200,
      message: "Search results retrieved successfully",
      data: result.rows,
    });
  } catch (error) {
    console.error("Tenant search error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to search tenants",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get all tenants with lease and property information
router.get("/", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    console.log("Fetching tenants for user:", req.user.id);

    // Main query to get tenants with lease and property details
    const tenantsQuery = `
      SELECT 
        t.id,
        t.first_name,
        t.last_name,
        t.email,
        t.phone,
        t.alternate_phone,
        t.date_of_birth,
        t.identification_type,
        t.identification_number,
        t.emergency_contact_name,
        t.emergency_contact_phone,
        t.emergency_contact_relationship,
        t.employment_status,
        t.employer_name,
        t.monthly_income,
        t.created_at,

        -- Blacklist information
    t.is_blacklisted,
    t.blacklist_reason,
    t.blacklist_severity,
    t.blacklisted_date,
    t.blacklisted_by,
    t.blacklist_notes,
        
        -- Current lease information
        l.id as lease_id,
        l.lease_number,
        l.lease_status,
        l.start_date,
        l.end_date,
        l.monthly_rent,
        l.security_deposit,
        l.move_in_date,
        l.move_out_date,
        
        -- Property and unit information
        p.property_name,
        p.address as property_address,
        u.unit_number,
        
        -- Lease tenant relationship
        lt.is_primary_tenant,
        lt.tenant_type,
        
        -- Payment status information
        (
          SELECT rp.payment_status 
          FROM rent_payments rp 
          WHERE rp.lease_id = l.id 
          ORDER BY rp.due_date DESC 
          LIMIT 1
        ) as last_payment_status,
        (
          SELECT rp.payment_date 
          FROM rent_payments rp 
          WHERE rp.lease_id = l.id 
          AND rp.payment_status = 'paid'
          ORDER BY rp.payment_date DESC 
          LIMIT 1
        ) as last_payment_date,
        
        -- Count overdue payments
        (
          SELECT COUNT(*) 
          FROM rent_payments rp 
          WHERE rp.lease_id = l.id 
          AND rp.payment_status = 'overdue'
        ) as overdue_payments_count
        
      FROM tenants t
      LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
      LEFT JOIN leases l ON lt.lease_id = l.id AND l.lease_status = 'active'
      LEFT JOIN units u ON l.unit_id = u.id
      LEFT JOIN properties p ON u.property_id = p.id
      ORDER BY t.created_at DESC
    `;

    const tenantsResult = await client.query(tenantsQuery);

    // Get payment history for each tenant
    const paymentHistoryQuery = `
      SELECT 
        rp.id,
        rp.lease_id,
        rp.payment_date,
        rp.due_date,
        rp.amount_due,
        rp.amount_paid,
        rp.payment_method,
        rp.payment_status,
        rp.late_fee,
        l.lease_number,
        lt.tenant_id
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id
      WHERE lt.removed_date IS NULL
      ORDER BY rp.due_date DESC
    `;

    const paymentsResult = await client.query(paymentHistoryQuery);

    // Get documents for each tenant
    const documentsQuery = `
      SELECT 
        td.id,
        td.tenant_id,
        td.document_type,
        td.document_name,
        td.file_path,
        td.upload_date,
        td.uploaded_by
      FROM tenant_documents td
      ORDER BY td.upload_date DESC
    `;

    const documentsResult = await client.query(documentsQuery);

    // Format the response data
    const paymentsByTenant = {};
    paymentsResult.rows.forEach((payment) => {
      if (!paymentsByTenant[payment.tenant_id]) {
        paymentsByTenant[payment.tenant_id] = [];
      }
      paymentsByTenant[payment.tenant_id].push({
        id: payment.id,
        date: payment.payment_date,
        dueDate: payment.due_date,
        amount: parseFloat(payment.amount_paid),
        amountDue: parseFloat(payment.amount_due),
        type: "Rent",
        status:
          payment.payment_status === "paid"
            ? "Paid"
            : payment.payment_status === "overdue"
              ? "Late"
              : "Pending",
        method: payment.payment_method,
        lateFee: parseFloat(payment.late_fee) || 0,
      });
    });

    const documentsByTenant = {};
    documentsResult.rows.forEach((doc) => {
      if (!documentsByTenant[doc.tenant_id]) {
        documentsByTenant[doc.tenant_id] = [];
      }
      documentsByTenant[doc.tenant_id].push({
        name: doc.document_name,
        type: doc.document_type.toLowerCase().replace(" ", "_"),
        date: doc.upload_date,
        uploadedBy: doc.uploaded_by,
      });
    });

    const formattedTenants = tenantsResult.rows.map((tenant) => {
      // Determine tenant status (update existing logic)
      let status = "Active";

      // Check blacklist status first
      if (tenant.is_blacklisted) {
        status = "Blacklisted";
      } else {
        // Your existing status logic...
        const today = new Date();
        const leaseEnd = tenant.end_date ? new Date(tenant.end_date) : null;

        if (tenant.overdue_payments_count > 0) {
          status = "Warning";
        } else if (leaseEnd && leaseEnd <= today) {
          status = "Expired";
        } else if (!tenant.lease_id) {
          status = "No Active Lease";
        }
      }

      return {
        id: tenant.id,
        name: `${tenant.first_name} ${tenant.last_name}`,
        email: tenant.email,
        phone: tenant.phone,
        alternatePhone: tenant.alternate_phone,
        dateOfBirth: tenant.date_of_birth,
        identificationType: tenant.identification_type,
        identificationNumber: tenant.identification_number,

        // Emergency contact
        emergencyContact: {
          name: tenant.emergency_contact_name,
          phone: tenant.emergency_contact_phone,
          relationship: tenant.emergency_contact_relationship,
        },

        // Employment info
        employmentStatus: tenant.employment_status,
        employerName: tenant.employer_name,
        monthlyIncome: parseFloat(tenant.monthly_income) || 0,

        // Property and lease info
        propertyId: tenant.lease_id ? 1 : null, // Simplified for now
        propertyName: tenant.property_name
          ? `${tenant.property_name}, ${tenant.unit_number ? `Unit ${tenant.unit_number}` : ""}`
          : "No Active Lease",
        leaseStart: tenant.start_date,
        leaseEnd: tenant.end_date,
        rentAmount: parseFloat(tenant.monthly_rent) || 0,
        securityDeposit: parseFloat(tenant.security_deposit) || 0,

        // Payment info
        paymentStatus:
          tenant.last_payment_status === "paid"
            ? "Paid"
            : tenant.last_payment_status === "overdue"
              ? "Late"
              : "Pending",
        lastPaymentDate: tenant.last_payment_date,

        // Add blacklist fields
        isBlacklisted: tenant.is_blacklisted || false,
        blacklistReason: tenant.blacklist_reason,
        blacklistSeverity: tenant.blacklist_severity,
        blacklistedDate: tenant.blacklisted_date,
        blacklistedBy: tenant.blacklisted_by,
        blacklistNotes: tenant.blacklist_notes,

        // Status and metadata
        status: status,
        isPrimaryTenant: tenant.is_primary_tenant || false,
        tenantType: tenant.tenant_type || "Tenant",
        createdAt: tenant.created_at,

        // Related data
        paymentHistory: paymentsByTenant[tenant.id] || [],
        documents: documentsByTenant[tenant.id] || [],
      };
    });

    // Calculate summary statistics
    const tenantStats = {
      totalTenants: formattedTenants.length,
      activeLeases: formattedTenants.filter((t) => t.status === "Active")
        .length,
      pendingPayments: formattedTenants.filter(
        (t) => t.paymentStatus === "Late"
      ).length,
      expiringLeases: formattedTenants.filter((t) => {
        if (!t.leaseEnd) return false;
        const leaseEnd = new Date(t.leaseEnd);
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        return leaseEnd <= thirtyDaysFromNow && leaseEnd > new Date();
      }).length,
    };

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        "tenants_viewed",
        "Viewed tenants list",
        req.ip,
        req.headers["user-agent"],
      ]
    );

    res.status(200).json({
      status: 200,
      message: "Tenants retrieved successfully",
      data: {
        tenants: formattedTenants,
        stats: tenantStats,
        totalCount: formattedTenants.length,
      },
    });
  } catch (error) {
    console.error("Tenants fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch tenants",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Create new tenant (onboarding)
router.post("/", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      firstName,
      lastName,
      email,
      phone,
      alternatePhone,
      dateOfBirth,
      identificationType,
      identificationNumber,
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelationship,
      employmentStatus,
      employerName,
      monthlyIncome,
      previousAddress,
      // Lease information
      propertyId,
      unitId,
      leaseStart,
      leaseEnd,
      monthlyRent,
      securityDeposit,
      leaseTerms,
      moveInDate,
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        status: 400,
        message: "First name, last name, and email are required",
      });
    }

    // Check if email already exists
    const emailCheck = await client.query(
      "SELECT id FROM tenants WHERE email = $1",
      [email]
    );

    if (emailCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: "Email already exists",
      });
    }

    // Insert tenant
    const tenantQuery = `
        INSERT INTO tenants (
          first_name, last_name, email, phone, alternate_phone,
          date_of_birth, identification_type, identification_number,
          emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
          employment_status, employer_name, monthly_income, previous_address
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `;

    const tenantResult = await client.query(tenantQuery, [
      firstName,
      lastName,
      email,
      phone,
      alternatePhone,
      dateOfBirth,
      identificationType,
      identificationNumber,
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelationship,
      employmentStatus,
      employerName,
      monthlyIncome,
      previousAddress,
    ]);

    const newTenant = tenantResult.rows[0];

    // Create lease if lease information is provided
    if (unitId && leaseStart && monthlyRent) {
      // Check if unit is available
      const unitCheck = await client.query(
        "SELECT occupancy_status FROM units WHERE id = $1",
        [unitId]
      );

      if (unitCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Unit not found",
        });
      }

      if (unitCheck.rows[0].occupancy_status === "occupied") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Unit is already occupied",
        });
      }

      // Create lease
      const leaseQuery = `
          INSERT INTO leases (
            unit_id, lease_status, start_date, end_date, monthly_rent,
            security_deposit, lease_terms, move_in_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `;

      const leaseResult = await client.query(leaseQuery, [
        unitId,
        "active",
        leaseStart,
        leaseEnd,
        monthlyRent,
        securityDeposit,
        leaseTerms,
        moveInDate,
      ]);

      const newLease = leaseResult.rows[0];

      // Link tenant to lease
      await client.query(
        "INSERT INTO lease_tenants (lease_id, tenant_id, is_primary_tenant) VALUES ($1, $2, $3)",
        [newLease.id, newTenant.id, true]
      );

      // Update unit status
      await client.query(
        "UPDATE units SET occupancy_status = $1 WHERE id = $2",
        ["occupied", unitId]
      );
    }

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        "tenant_created",
        `Created new tenant: ${firstName} ${lastName}`,
        "tenant",
        newTenant.id,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      status: 201,
      message: "Tenant created successfully",
      data: newTenant,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Tenant creation error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to create tenant",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get single tenant by ID with detailed information
router.get("/:id", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.id;

    const tenantQuery = `
        SELECT 
          t.*,
          l.id as lease_id,
          l.lease_number,
          l.lease_status,
          l.start_date,
          l.end_date,
          l.monthly_rent,
          l.security_deposit,
          p.property_name,
          u.unit_number,
          lt.is_primary_tenant,
          lt.tenant_type
        FROM tenants t
        LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
        LEFT JOIN leases l ON lt.lease_id = l.id AND l.lease_status = 'active'
        LEFT JOIN units u ON l.unit_id = u.id
        LEFT JOIN properties p ON u.property_id = p.id
        WHERE t.id = $1
      `;

    const tenantResult = await client.query(tenantQuery, [tenantId]);

    if (tenantResult.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Tenant not found",
      });
    }

    res.status(200).json({
      status: 200,
      message: "Tenant retrieved successfully",
      data: tenantResult.rows[0],
    });
  } catch (error) {
    console.error("Tenant fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch tenant",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Update tenant information
router.put("/:id", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.id;
    const {
      firstName,
      lastName,
      email,
      phone,
      alternatePhone,
      dateOfBirth,
      identificationType,
      identificationNumber,
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelationship,
      employmentStatus,
      employerName,
      monthlyIncome,
      previousAddress,
    } = req.body;

    // Check if tenant exists
    const tenantCheck = await client.query(
      "SELECT id FROM tenants WHERE id = $1",
      [tenantId]
    );

    if (tenantCheck.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Tenant not found",
      });
    }

    // Handle empty strings for numeric and date fields - SAME AS ONBOARDING
    const processedMonthlyIncome =
      monthlyIncome && monthlyIncome.toString().trim() !== ""
        ? parseFloat(monthlyIncome)
        : null;

    const processedDateOfBirth =
      dateOfBirth && dateOfBirth.trim() !== "" ? dateOfBirth : null;

    // Update tenant with processed data
    const updateQuery = `
        UPDATE tenants SET 
          first_name = $1,
          last_name = $2,
          email = $3,
          phone = $4,
          alternate_phone = $5,
          date_of_birth = $6,
          identification_type = $7,
          identification_number = $8,
          emergency_contact_name = $9,
          emergency_contact_phone = $10,
          emergency_contact_relationship = $11,
          employment_status = $12,
          employer_name = $13,
          monthly_income = $14,
          previous_address = $15,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $16
        RETURNING *
      `;

    const result = await client.query(updateQuery, [
      firstName,
      lastName,
      email,
      phone,
      alternatePhone || null, // Handle empty strings
      processedDateOfBirth, // Processed date
      identificationType || null, // Handle empty strings
      identificationNumber || null, // Handle empty strings
      emergencyContactName || null, // Handle empty strings
      emergencyContactPhone || null, // Handle empty strings
      emergencyContactRelationship || null, // Handle empty strings
      employmentStatus || null, // Handle empty strings
      employerName || null, // Handle empty strings
      processedMonthlyIncome, // Processed numeric value
      previousAddress || null, // Handle empty strings
      tenantId,
    ]);

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        "tenant_updated",
        `Updated tenant: ${firstName} ${lastName}`,
        "tenant",
        tenantId,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    res.status(200).json({
      status: 200,
      message: "Tenant updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Tenant update error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to update tenant",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Offboard tenant (terminate lease)
// POST /api/tenants/:id/offboard - Offboard tenant (terminate lease)
router.post("/:id/offboard", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tenantId = req.params.id;
    const {
      moveOutDate,
      depositRefund,
      deductions = [],
      notes,
      confirmAddress,
      keyReturn,
      inspectionFindings,
      handleUnpaidRent = 'deduct', // 'deduct' or 'writeoff'
    } = req.body;

    // Validate required fields
    if (!moveOutDate) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: "Move-out date is required",
      });
    }

    // Get tenant and current lease information
    const tenantQuery = `
      SELECT 
        t.first_name,
        t.last_name,
        t.email,
        l.id as lease_id,
        l.lease_number,
        l.security_deposit,
        l.start_date as lease_start,
        u.id as unit_id,
        u.unit_number,
        p.property_name
      FROM tenants t
      JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
      JOIN leases l ON lt.lease_id = l.id AND l.lease_status = 'active'
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE t.id = $1
    `;

    const tenantResult = await client.query(tenantQuery, [tenantId]);

    if (tenantResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Tenant not found or no active lease",
      });
    }

    const tenant = tenantResult.rows[0];

    // ========================================
    // STEP 1: Handle Unpaid Rent
    // ========================================
    
    // Get all unpaid rent for this lease
    const unpaidRentQuery = `
      SELECT 
        id, 
        due_date, 
        amount_due, 
        amount_paid,
        late_fee,
        payment_status,
        (amount_due + late_fee - amount_paid) as balance
      FROM rent_payments
      WHERE lease_id = $1 
      AND payment_status IN ('pending', 'overdue', 'partial')
      ORDER BY due_date
    `;

    const unpaidRentResult = await client.query(unpaidRentQuery, [tenant.lease_id]);
    const unpaidRentRecords = unpaidRentResult.rows;

    // Calculate total unpaid rent
    const totalUnpaidRent = unpaidRentRecords.reduce((sum, payment) => {
      return sum + parseFloat(payment.balance);
    }, 0);

    let rentSettlementMethod = 'none';
    let finalDeductions = [...deductions];

    // Handle unpaid rent based on selected method
    if (totalUnpaidRent > 0) {
      if (handleUnpaidRent === 'deduct') {
        // OPTION 1: Deduct from security deposit
        rentSettlementMethod = 'deducted_from_deposit';
        
        // Add unpaid rent to deductions
        finalDeductions.push({
          description: 'Unpaid Rent Settlement',
          amount: totalUnpaidRent
        });
        
        // Mark all unpaid rent as "paid from deposit"
        for (const payment of unpaidRentRecords) {
          const amountToSettle = parseFloat(payment.balance);
          const newAmountPaid = parseFloat(payment.amount_paid) + amountToSettle;
          
          await client.query(
            `UPDATE rent_payments 
             SET payment_status = 'paid',
                 payment_method = 'Security Deposit Deduction',
                 payment_date = $1,
                 amount_paid = $2,
                 notes = COALESCE(notes || ' | ', '') || 'Settled from security deposit during offboarding',
                 processed_by = $3,
                 processed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [moveOutDate, newAmountPaid, req.user.username, payment.id]
          );

          // Log payment history
          await client.query(
            `INSERT INTO payment_history 
             (payment_id, change_type, old_status, new_status, old_amount, new_amount, changed_by, change_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              payment.id,
              'payment_received',
              payment.payment_status,
              'paid',
              payment.amount_paid,
              newAmountPaid,
              req.user.id,
              'Settled from security deposit during tenant offboarding'
            ]
          );
        }
      } else if (handleUnpaidRent === 'writeoff') {
        // OPTION 2: Write off as bad debt
        rentSettlementMethod = 'written_off';
        
        for (const payment of unpaidRentRecords) {
          await client.query(
            `UPDATE rent_payments 
             SET payment_status = 'written_off',
                 notes = COALESCE(notes || ' | ', '') || 'Written off as bad debt - tenant offboarded with unpaid balance',
                 processed_by = $1,
                 processed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [req.user.username, payment.id]
          );

          // Log payment history
          await client.query(
            `INSERT INTO payment_history 
             (payment_id, change_type, old_status, new_status, changed_by, change_reason, additional_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              payment.id,
              'status_updated',
              payment.payment_status,
              'written_off',
              req.user.id,
              'Written off during tenant offboarding',
              JSON.stringify({ unpaid_amount: payment.balance })
            ]
          );
        }
        
        // Log the debt in activity log
        await client.query(
          `INSERT INTO user_activity_log 
           (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, additional_data)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            req.user.id,
            'tenant_debt_recorded',
            `Tenant offboarded with written-off unpaid rent: ${formatCurrency(totalUnpaidRent)}`,
            'tenant',
            tenantId,
            JSON.stringify({ 
              unpaidRent: totalUnpaidRent, 
              rentRecords: unpaidRentRecords.map(r => ({
                id: r.id,
                due_date: r.due_date,
                balance: r.balance
              }))
            })
          ]
        );
      }
    }

    // ========================================
    // STEP 2: Update Lease Status
    // ========================================
    
    await client.query(
      `UPDATE leases SET 
         lease_status = 'terminated',
         move_out_date = $1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [moveOutDate, tenant.lease_id]
    );

    // Update lease_tenants with removal date
    await client.query(
      "UPDATE lease_tenants SET removed_date = $1 WHERE lease_id = $2 AND tenant_id = $3",
      [moveOutDate, tenant.lease_id, tenantId]
    );

    // Update unit status to vacant
    await client.query(
      "UPDATE units SET occupancy_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", 
      ["vacant", tenant.unit_id]
    );

    // ========================================
    // STEP 3: Process Security Deposit
    // ========================================
    
    // Calculate total deductions (including unpaid rent if deducted)
    const totalDeductions = finalDeductions.reduce(
      (sum, deduction) => sum + (parseFloat(deduction.amount) || 0),
      0
    );

    // Parse values correctly
    const originalDeposit = parseFloat(tenant.security_deposit) || 0;
    const actualRefund = Math.max(0, originalDeposit - totalDeductions);

    // Validate the math
    if (totalDeductions > originalDeposit) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: `Total deductions (${formatCurrency(totalDeductions)}) exceed security deposit (${formatCurrency(originalDeposit)})`,
        data: {
          originalDeposit,
          totalDeductions,
          deductions: finalDeductions
        }
      });
    }

    // Create security deposit settlement record
    await client.query(
      `INSERT INTO security_deposits (
          lease_id, 
          deposit_type, 
          amount_collected, 
          collection_date,
          amount_returned, 
          return_date, 
          deductions, 
          deduction_reason, 
          deduction_itemization,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tenant.lease_id,
        "Security",
        originalDeposit,
        tenant.lease_start || new Date(),
        actualRefund,
        moveOutDate,
        totalDeductions,
        finalDeductions.map((d) => `${d.description}: ${formatCurrency(d.amount)}`).join("; "),
        JSON.stringify(finalDeductions),
        actualRefund === originalDeposit
          ? "fully_returned"
          : actualRefund > 0
            ? "partially_returned"
            : "forfeited",
      ]
    );

    // ========================================
    // STEP 4: Create Offboarding Record
    // ========================================
    
    const offboardingData = {
      moveOutDate,
      depositRefund: actualRefund,
      deductions: finalDeductions.map(d => ({
        description: d.description,
        amount: parseFloat(d.amount) || 0
      })),
      totalDeductions,
      originalDeposit,
      notes,
      confirmAddress,
      keyReturn,
      inspectionFindings,
      processedBy: req.user.username,
      processedAt: new Date(),
      
      // Rent settlement information
      unpaidRentAmount: totalUnpaidRent,
      rentSettlementMethod,
      unpaidRentRecords: unpaidRentRecords.length > 0 ? unpaidRentRecords.map(r => ({
        id: r.id,
        due_date: r.due_date,
        balance: r.balance
      })) : []
    };

    // Log offboarding activity
    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent, additional_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user.id,
        "tenant_offboarded",
        `Offboarded tenant: ${tenant.first_name} ${tenant.last_name} from ${tenant.property_name} Unit ${tenant.unit_number}`,
        "tenant",
        tenantId,
        req.ip,
        req.headers["user-agent"],
        JSON.stringify(offboardingData),
      ]
    );

    await client.query("COMMIT");

    res.status(200).json({
      status: 200,
      message: "Tenant offboarded successfully",
      data: {
        tenantId,
        leaseId: tenant.lease_id,
        moveOutDate,
        securityDepositRefund: actualRefund,
        totalDeductions,
        unpaidRentSettled: totalUnpaidRent,
        rentSettlementMethod,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Tenant offboarding error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to offboard tenant",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Helper function (add at top of file if not exists)
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'KES'
  }).format(amount);
}

// GET /api/tenants/:id/unpaid-rent - Get total unpaid rent for tenant
router.get("/:id/unpaid-rent", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.id;

    const query = `
      SELECT 
        rp.id,
        rp.due_date,
        rp.amount_due,
        rp.amount_paid,
        rp.late_fee,
        rp.payment_status,
        (rp.amount_due + rp.late_fee - rp.amount_paid) as balance
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id
      WHERE lt.tenant_id = $1
      AND rp.payment_status IN ('pending', 'overdue', 'partial')
      ORDER BY rp.due_date
    `;

    const result = await client.query(query, [tenantId]);
    
    const totalUnpaid = result.rows.reduce((sum, payment) => 
      sum + parseFloat(payment.balance), 0
    );

    res.status(200).json({
      status: 200,
      message: "Unpaid rent retrieved successfully",
      data: {
        totalUnpaid,
        payments: result.rows,
        count: result.rows.length
      }
    });
  } catch (error) {
    console.error("Unpaid rent fetch error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch unpaid rent",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get tenant payment history
router.get("/:id/payments", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.id;

    const paymentsQuery = `
        SELECT 
          rp.id,
          rp.payment_date,
          rp.due_date,
          rp.amount_due,
          rp.amount_paid,
          rp.payment_method,
          rp.payment_status,
          rp.late_fee,
          rp.payment_reference,
          rp.notes,
          l.lease_number,
          l.monthly_rent
        FROM rent_payments rp
        JOIN leases l ON rp.lease_id = l.id
        JOIN lease_tenants lt ON l.id = lt.lease_id
        WHERE lt.tenant_id = $1
        ORDER BY rp.due_date DESC
      `;

    const result = await client.query(paymentsQuery, [tenantId]);

    res.status(200).json({
      status: 200,
      message: "Payment history retrieved successfully",
      data: result.rows,
    });
  } catch (error) {
    console.error("Payment history fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch payment history",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get tenant documents
// GET /api/tenants/:id/documents - Get all documents for a tenant
router.get("/:id/documents", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.id;

    // Check if tenant exists
    const tenantCheck = await client.query(
      "SELECT id FROM tenants WHERE id = $1",
      [tenantId]
    );

    if (tenantCheck.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Tenant not found",
      });
    }

    // Query both tenant_documents and documents tables
   // Query both tenant_documents and documents tables
const documentsQuery = `
SELECT 
  id,
  document_type,
  document_name,
  file_path,
  file_size,
  mime_type,
  upload_date,
  uploaded_by::VARCHAR as uploaded_by,
  is_verified,
  verified_by::VARCHAR as verified_by,
  verified_date,
  expiration_date
FROM (
  SELECT 
    td.id,
    td.document_type,
    td.document_name,
    td.file_path,
    td.file_size,
    td.mime_type,
    td.upload_date,
    CASE 
      WHEN td.uploaded_by IS NOT NULL THEN 
        (SELECT u.username FROM users u WHERE u.id = td.uploaded_by)
      ELSE NULL 
    END as uploaded_by,
    td.is_verified,
    CASE 
      WHEN td.verified_by IS NOT NULL THEN 
        (SELECT u.username FROM users u WHERE u.id = td.verified_by)
      ELSE NULL 
    END as verified_by,
    td.verified_date,
    td.expiration_date
  FROM tenant_documents td
  WHERE td.tenant_id = $1
  
  UNION ALL
  
  SELECT 
    d.id,
    d.document_type,
    d.document_name,
    d.file_path,
    d.file_size,
    d.mime_type,
    d.uploaded_at as upload_date,
    d.uploaded_by,
    false as is_verified,
    NULL as verified_by,
    NULL as verified_date,
    d.expires_at as expiration_date
  FROM documents d
  WHERE d.tenant_id = $1
) combined
ORDER BY upload_date DESC
`;

    const result = await client.query(documentsQuery, [tenantId]);

    // Format the documents for frontend
    const formattedDocuments = result.rows.map(doc => ({
      id: doc.id,
      name: doc.document_name,
      type: doc.document_type,
      date: doc.upload_date,
      uploadedAt: doc.upload_date,
      uploadedBy: doc.uploaded_by,
      size: doc.file_size,
      mimeType: doc.mime_type,
      filePath: doc.file_path,
      isVerified: doc.is_verified,
      verifiedBy: doc.verified_by,
      verifiedDate: doc.verified_date,
      expirationDate: doc.expiration_date
    }));

    res.status(200).json({
      status: 200,
      message: "Tenant documents retrieved successfully",
      data: formattedDocuments,
    });
  } catch (error) {
    console.error("Documents fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch tenant documents",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// GET /api/tenants/documents/:documentId/download - Download a document
router.get("/documents/:documentId/download", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const documentId = req.params.documentId;

    // Try to find document in tenant_documents first
    let documentQuery = `
      SELECT 
        td.file_path,
        td.document_name,
        td.mime_type,
        td.tenant_id
      FROM tenant_documents td
      WHERE td.id = $1
    `;

    let result = await client.query(documentQuery, [documentId]);

    // If not found, try documents table
    if (result.rows.length === 0) {
      documentQuery = `
        SELECT 
          d.file_path,
          d.document_name,
          d.mime_type,
          d.tenant_id
        FROM documents d
        WHERE d.id = $1
      `;

      result = await client.query(documentQuery, [documentId]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Document not found",
      });
    }

    const document = result.rows[0];

    // Check if file exists
    try {
      await fs.access(document.file_path);
    } catch (error) {
      return res.status(404).json({
        status: 404,
        message: "File not found on server",
      });
    }

    // Log document access
    await logDocumentAccess(
      client,
      documentId,
      req.user.id,
      'download',
      req.ip,
      req.headers['user-agent']
    );

    // Set headers for file download
    res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${document.document_name}"`);

    // Stream the file
    const fileStream = createReadStream(document.file_path);
    fileStream.pipe(res);

  } catch (error) {
    console.error("Document download error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to download document",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// GET /api/tenants/documents/:documentId/view - View a document (inline)
router.get("/documents/:documentId/view", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const documentId = req.params.documentId;

    // Try to find document in tenant_documents first
    let documentQuery = `
      SELECT 
        td.file_path,
        td.document_name,
        td.mime_type,
        td.tenant_id
      FROM tenant_documents td
      WHERE td.id = $1
    `;

    let result = await client.query(documentQuery, [documentId]);

    // If not found, try documents table
    if (result.rows.length === 0) {
      documentQuery = `
        SELECT 
          d.file_path,
          d.document_name,
          d.mime_type,
          d.tenant_id
        FROM documents d
        WHERE d.id = $1
      `;

      result = await client.query(documentQuery, [documentId]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Document not found",
      });
    }

    const document = result.rows[0];

    // Check if file exists
    try {
      await fs.access(document.file_path);
    } catch (error) {
      return res.status(404).json({
        status: 404,
        message: "File not found on server",
      });
    }

    // Log document access
    await logDocumentAccess(
      client,
      documentId,
      req.user.id,
      'view',
      req.ip,
      req.headers['user-agent']
    );

    // Set headers for inline viewing
    res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${document.document_name}"`);

    // Stream the file
    const fileStream = createReadStream(document.file_path);
    fileStream.pipe(res);

  } catch (error) {
    console.error("Document view error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to view document",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Upload tenant document
router.post("/:id/documents", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.id;
    const { documentType, documentName, filePath, fileSize, mimeType } =
      req.body;

    // Validate required fields
    if (!documentType || !documentName || !filePath) {
      return res.status(400).json({
        status: 400,
        message: "Document type, name, and file path are required",
      });
    }

    // Check if tenant exists
    const tenantCheck = await client.query(
      "SELECT id FROM tenants WHERE id = $1",
      [tenantId]
    );

    if (tenantCheck.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Tenant not found",
      });
    }

    // Insert document record
    const documentQuery = `
        INSERT INTO tenant_documents (
          tenant_id, document_type, document_name, file_path,
          file_size, mime_type, upload_date, uploaded_by
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7)
        RETURNING *
      `;

    const result = await client.query(documentQuery, [
      tenantId,
      documentType,
      documentName,
      filePath,
      fileSize,
      mimeType,
      req.user.username,
    ]);

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        "document_uploaded",
        `Uploaded document: ${documentName} for tenant`,
        "tenant_document",
        result.rows[0].id,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    res.status(201).json({
      status: 201,
      message: "Document uploaded successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Document upload error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to upload document",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Blacklist a tenant
router.post(
  "/:id/blacklist",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin", "Manager"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const tenantId = req.params.id;
      const {
        reason,
        severity = "medium",
        notes,
        evidenceDocuments = [],
        categoryId,
      } = req.body;

      // Validate required fields
      if (!reason) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Blacklist reason is required",
        });
      }

      // Check if tenant exists
      const tenantCheck = await client.query(
        "SELECT id, first_name, last_name, is_blacklisted FROM tenants WHERE id = $1",
        [tenantId]
      );

      if (tenantCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Tenant not found",
        });
      }

      const tenant = tenantCheck.rows[0];

      if (tenant.is_blacklisted) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Tenant is already blacklisted",
        });
      }

      // Update tenant blacklist status
      await client.query(
        `UPDATE tenants SET 
       is_blacklisted = true,
       blacklist_reason = $1,
       blacklisted_date = CURRENT_TIMESTAMP,
       blacklisted_by = $2,
       blacklist_notes = $3,
       blacklist_severity = $4,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
        [reason, req.user.username, notes, severity, tenantId]
      );

      // Record in blacklist history
      await client.query(
        `INSERT INTO tenant_blacklist_history 
       (tenant_id, action, reason, severity, notes, evidence_documents, performed_by, previous_status, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          "blacklisted",
          reason,
          severity,
          notes,
          evidenceDocuments,
          req.user.username,
          false,
          req.ip,
        ]
      );

      // Log activity
      await client.query(
        `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user.id,
          "tenant_blacklisted",
          `Blacklisted tenant: ${tenant.first_name} ${tenant.last_name} - Reason: ${reason}`,
          "tenant",
          tenantId,
          req.ip,
          req.headers["user-agent"],
        ]
      );

      await client.query("COMMIT");

      res.status(200).json({
        status: 200,
        message: "Tenant blacklisted successfully",
        data: {
          tenantId,
          reason,
          severity,
          blacklistedBy: req.user.username,
          blacklistedAt: new Date(),
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Tenant blacklisting error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to blacklist tenant",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Remove from blacklist
// Remove from blacklist
router.post(
  "/:id/remove-blacklist",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const tenantId = req.params.id;
      const { removalReason, notes } = req.body;

      // Validate required fields
      if (!removalReason) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Removal reason is required",
        });
      }

      // Check if tenant exists and is blacklisted
      const tenantCheck = await client.query(
        "SELECT id, first_name, last_name, is_blacklisted, blacklist_reason FROM tenants WHERE id = $1",
        [tenantId]
      );

      if (tenantCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Tenant not found",
        });
      }

      const tenant = tenantCheck.rows[0];

      if (!tenant.is_blacklisted) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Tenant is not currently blacklisted",
        });
      }

      // FIRST: Manually record removal in history before updating tenant
      await client.query(
        `INSERT INTO tenant_blacklist_history 
         (tenant_id, action, reason, notes, performed_by, previous_status, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          "removed",
          removalReason,
          notes,
          req.user.username,
          true,
          req.ip,
        ]
      );

      // THEN: Remove blacklist status (setting blacklisted_by to NULL is okay here)
      await client.query(
        `UPDATE tenants SET 
         is_blacklisted = false,
         blacklist_reason = NULL,
         blacklisted_date = NULL,
         blacklisted_by = NULL,
         blacklist_notes = NULL,
         blacklist_severity = NULL,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [tenantId]
      );

      // Log activity
      await client.query(
        `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.user.id,
          "tenant_blacklist_removed",
          `Removed blacklist for tenant: ${tenant.first_name} ${tenant.last_name} - Reason: ${removalReason}`,
          "tenant",
          tenantId,
          req.ip,
          req.headers["user-agent"],
        ]
      );

      await client.query("COMMIT");

      res.status(200).json({
        status: 200,
        message: "Tenant removed from blacklist successfully",
        data: {
          tenantId,
          removalReason,
          removedBy: req.user.username,
          removedAt: new Date(),
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Blacklist removal error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to remove tenant from blacklist",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);
// Get blacklist history for a tenant
router.get(
  "/:id/blacklist-history",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const tenantId = req.params.id;

      const historyQuery = `
      SELECT 
        bh.id,
        bh.action,
        bh.reason,
        bh.severity,
        bh.notes,
        bh.evidence_documents,
        bh.performed_by,
        bh.performed_at,
        bh.previous_status,
        bc.category_name
      FROM tenant_blacklist_history bh
      LEFT JOIN blacklist_categories bc ON bh.reason = bc.category_name
      WHERE bh.tenant_id = $1
      ORDER BY bh.performed_at DESC
    `;

      const result = await client.query(historyQuery, [tenantId]);

      res.status(200).json({
        status: 200,
        message: "Blacklist history retrieved successfully",
        data: result.rows,
      });
    } catch (error) {
      console.error("Blacklist history fetch error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to fetch blacklist history",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

export default router;
