import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = express.Router();

const uploadDir = "/home/files/rms-files/maintenance-photos";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "maintenance-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Only image files are allowed (jpeg, jpg, png, gif, webp)"));
    }
  },
});

// Get all maintenance requests with filtering and pagination
router.get("/", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    console.log("Fetching maintenance requests for user:", req.user.id);

    const {
      status = "all",
      priority = "all",
      category = "all",
      page = 1,
      limit = 50,
      search = "",
      sortBy = "requested_date",
      sortOrder = "DESC",
    } = req.query;

    // Build dynamic WHERE clause
    let whereConditions = ["1=1"]; // Base condition
    let queryParams = [];
    let paramIndex = 1;

    // Filter by status
    if (status !== "all") {
      whereConditions.push(`mr.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }

    // Filter by priority
    if (priority !== "all") {
      whereConditions.push(`mr.priority = $${paramIndex}`);
      queryParams.push(priority);
      paramIndex++;
    }

    // Filter by category
    if (category !== "all") {
      whereConditions.push(`mr.category = $${paramIndex}`);
      queryParams.push(category);
      paramIndex++;
    }

    // Search functionality
    if (search) {
      whereConditions.push(`(
        mr.request_title ILIKE $${paramIndex} OR 
        mr.description ILIKE $${paramIndex} OR 
        p.property_name ILIKE $${paramIndex} OR
        u.unit_number ILIKE $${paramIndex} OR
        t.first_name ILIKE $${paramIndex} OR
        t.last_name ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.join(" AND ");

    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Main query to get maintenance requests
    const maintenanceQuery = `
      SELECT 
            mr.id,
    mr.request_title,
    mr.description,
    mr.priority,
    mr.category,
    mr.status,
    mr.requested_date,
    mr.scheduled_date,
    mr.completed_date,
    mr.estimated_cost,
    mr.actual_cost,
    mr.assigned_to,
    mr.tenant_notes,
    mr.management_notes,

     -- ADD THIS PHOTOS SUBQUERY:
    (
      SELECT json_agg(
        json_build_object(
          'id', p.id,
          'fileName', p.file_name,
          'filePath', p.file_path,
          'fileSize', p.file_size,
          'mimeType', p.mime_type,
          'uploadedAt', p.uploaded_at,
          'isBeforePhoto', p.is_before_photo
        )
        ORDER BY p.display_order, p.uploaded_at DESC
      )
      FROM maintenance_request_photos p
      WHERE p.maintenance_request_id = mr.id
    ) as photos,
     
        
        -- Property and unit information
        p.id as property_id,
        p.property_name,
        p.address as property_address,
        u.id as unit_id,
        u.unit_number,
        
        -- Tenant information
        t.id as tenant_id,
        t.first_name || ' ' || t.last_name as tenant_name,
        t.phone as tenant_phone,
        t.email as tenant_email,
        
        -- Lease information
        l.id as lease_id,
        l.lease_number
        
      FROM maintenance_requests mr
      JOIN units u ON mr.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN tenants t ON mr.tenant_id = t.id
      LEFT JOIN leases l ON mr.lease_id = l.id
      WHERE ${whereClause}
      ORDER BY mr.${sortBy} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(limit, offset);

    const maintenanceResult = await client.query(maintenanceQuery, queryParams);

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM maintenance_requests mr
      JOIN units u ON mr.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN tenants t ON mr.tenant_id = t.id
      LEFT JOIN leases l ON mr.lease_id = l.id
      WHERE ${whereClause}
    `;

    const countResult = await client.query(
      countQuery,
      queryParams.slice(0, -2)
    ); // Remove limit and offset

    // Get summary statistics
    const statsQuery = `
      SELECT 
        COUNT(*) as total_requests,
        COUNT(CASE WHEN mr.status = 'open' THEN 1 END) as open_requests,
        COUNT(CASE WHEN mr.status = 'in_progress' THEN 1 END) as in_progress_requests,
        COUNT(CASE WHEN mr.status = 'completed' THEN 1 END) as completed_requests,
        COUNT(CASE WHEN mr.priority = 'high' THEN 1 END) as high_priority_requests,
        COUNT(CASE WHEN mr.priority = 'emergency' THEN 1 END) as emergency_requests,
        AVG(CASE WHEN mr.actual_cost IS NOT NULL THEN mr.actual_cost END) as avg_cost,
        SUM(CASE WHEN mr.actual_cost IS NOT NULL THEN mr.actual_cost ELSE 0 END) as total_cost
      FROM maintenance_requests mr
      JOIN units u ON mr.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN tenants t ON mr.tenant_id = t.id
      LEFT JOIN leases l ON mr.lease_id = l.id
    `;

    const statsResult = await client.query(statsQuery);

    // Format the response data
    const formattedRequests = maintenanceResult.rows.map((request) => ({
      id: request.id,
      title: request.request_title,
      description: request.description,
      priority: request.priority,
      category: request.category,
      status: request.status,
      createdAt: request.requested_date,
      scheduledDate: request.scheduled_date,
      completedDate: request.completed_date,
      estimatedCost: parseFloat(request.estimated_cost) || 0,
      actualCost: parseFloat(request.actual_cost) || 0,
      assignedTo: request.assigned_to,
      tenantNotes: request.tenant_notes,
      managementNotes: request.management_notes,

      // ADD THIS:
  photos: request.photos || [],
  photoCount: request.photos ? request.photos.length : 0,

      // Property details (as object for consistency)
      property: {
        id: request.property_id,
        name: request.property_name,
      },
      propertyId: request.property_id,
      
      // Unit details (as object for consistency)
      unit: {
        id: request.unit_id,
        number: request.unit_number,
      },
      unitId: request.unit_id,

      // Tenant details
      tenantName: request.tenant_name,
      tenantContact: request.tenant_phone,
      tenantEmail: request.tenant_email,
      tenantId: request.tenant_id,

      // Lease details
      leaseNumber: request.lease_number,
      leaseId: request.lease_id,

      // Status mappings for frontend
      dateSubmitted: request.requested_date?.toISOString().split("T")[0],
      propertyName: request.property_name,

      // Add updates array (will be populated separately if needed)
      updates: [],
    }));

    const totalRequests = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalRequests / limit);

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        "maintenance_requests_viewed",
        "Viewed maintenance requests list",
        req.ip,
        req.headers["user-agent"],
      ]
    );

    res.status(200).json({
      status: 200,
      message: "Maintenance requests retrieved successfully",
      data: {
        requests: formattedRequests,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalRequests,
          limit: parseInt(limit),
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        stats: {
          totalRequests: parseInt(statsResult.rows[0].total_requests),
          openRequests: parseInt(statsResult.rows[0].open_requests),
          inProgressRequests: parseInt(
            statsResult.rows[0].in_progress_requests
          ),
          completedRequests: parseInt(statsResult.rows[0].completed_requests),
          highPriorityRequests: parseInt(
            statsResult.rows[0].high_priority_requests
          ),
          emergencyRequests: parseInt(statsResult.rows[0].emergency_requests),
          averageCost: parseFloat(statsResult.rows[0].avg_cost) || 0,
          totalCost: parseFloat(statsResult.rows[0].total_cost) || 0,
        },
        filters: {
          status,
          priority,
          category,
          search,
        },
      },
    });
  } catch (error) {
    console.error("Maintenance requests fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch maintenance requests",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});
// Get tenants for a specific unit
router.get("/units/:unitId/tenants", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { unitId } = req.params;
    
    console.log('📋 Fetching tenants for unit:', unitId);
    
    const tenantsQuery = `
      SELECT 
        t.id,
        t.first_name || ' ' || t.last_name as name,
        t.first_name,
        t.last_name,
        t.email,
        t.phone,
        lt.is_primary_tenant,
        l.id as "leaseId",
        l.lease_number,
        l.lease_status
      FROM leases l
      JOIN lease_tenants lt ON l.id = lt.lease_id
      JOIN tenants t ON lt.tenant_id = t.id
      WHERE l.unit_id = $1 
        AND l.lease_status = 'active'
        AND lt.removed_date IS NULL
      ORDER BY lt.is_primary_tenant DESC, t.first_name ASC
    `;
    
    const result = await client.query(tenantsQuery, [unitId]);
    
    console.log(`✅ Found ${result.rows.length} tenant(s) for unit ${unitId}`);
    
    res.status(200).json({
      status: 200,
      message: "Tenants retrieved successfully",
      data: result.rows
    });
  } catch (error) {
    console.error("❌ Error fetching tenants for unit:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch tenants",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get single maintenance request by ID with detailed information
router.get("/:id", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    // ✅ FIX: Convert string ID to integer
    const requestId = parseInt(req.params.id);
    
    if (isNaN(requestId)) {
      return res.status(400).json({
        status: 400,
        message: "Invalid maintenance request ID"
      });
    }

    const requestQuery = `
      SELECT 
        mr.id,
        mr.request_title,
        mr.description,
        mr.priority,
        mr.category,
        mr.status,
        mr.requested_date,
        mr.scheduled_date,
        mr.completed_date,
        mr.estimated_cost,
        mr.actual_cost,
        mr.assigned_to,
        mr.tenant_notes,
        mr.management_notes,
        mr.entry_allowed,
        mr.tenant_feedback,
        
        -- Property and unit information
        p.id as property_id,
        p.property_name,
        p.address as property_address,
        u.id as unit_id,
        u.unit_number,
        
        -- Tenant information
        t.id as tenant_id,
        t.first_name || ' ' || t.last_name as tenant_name,
        t.phone as tenant_phone,
        t.email as tenant_email,
        
        -- Lease information
        l.id as lease_id,
        l.lease_number,
        
        -- Assigned staff information (if storing username)
        CASE 
          WHEN mr.assigned_to IS NOT NULL THEN
            (SELECT us.first_name || ' ' || us.last_name 
             FROM users us 
             WHERE us.username = mr.assigned_to)
          ELSE NULL
        END as assigned_to_name,
        
        -- Photos
        (
          SELECT json_agg(
            json_build_object(
              'id', photo.id,
              'fileName', photo.file_name,
              'filePath', photo.file_path,
              'fileSize', photo.file_size,
              'mimeType', photo.mime_type,
              'uploadedAt', photo.uploaded_at,
              'uploadedBy', photo.uploaded_by,
              'uploadedByName', (SELECT us.first_name || ' ' || us.last_name FROM users us WHERE us.id = photo.uploaded_by),
              'isBeforePhoto', photo.is_before_photo,
              'description', photo.description,
              'displayOrder', photo.display_order
            )
            ORDER BY photo.display_order, photo.uploaded_at DESC
          )
          FROM maintenance_request_photos photo
          WHERE photo.maintenance_request_id = mr.id
        ) as photos,
        
        -- Updates/Comments
        (
          SELECT json_agg(
            json_build_object(
              'id', mru.id,
              'updateText', mru.update_text,
              'updateType', mru.update_type,
              'createdAt', mru.created_at,
              'createdBy', mru.created_by,
              'createdByName', (SELECT us.first_name || ' ' || us.last_name FROM users us WHERE us.id = mru.created_by),
              'isInternal', mru.is_internal
            )
            ORDER BY mru.created_at DESC
          )
          FROM maintenance_request_updates mru
          WHERE mru.maintenance_request_id = mr.id
        ) as updates
        
      FROM maintenance_requests mr
      JOIN units u ON mr.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN tenants t ON mr.tenant_id = t.id
      LEFT JOIN leases l ON mr.lease_id = l.id
      WHERE mr.id = $1
    `;

    const requestResult = await client.query(requestQuery, [requestId]);

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Maintenance request not found",
      });
    }

    const request = requestResult.rows[0];

    // Get related communications for this maintenance request
    const communicationsQuery = `
    SELECT 
      c.id,
      c.communication_type,
      c.subject,
      c.message_content,
      c.direction,
      c.communication_date,
      c.staff_member,
      c.follow_up_required,
      c.follow_up_date
    FROM communications c
    WHERE (
      ($1::INTEGER IS NOT NULL AND c.lease_id = $1::INTEGER) OR
      ($2::INTEGER IS NOT NULL AND c.tenant_id = $2::INTEGER)
    )
    AND c.communication_date >= $3
    AND (c.subject LIKE '%Maintenance%' OR c.message_content LIKE '%maintenance%')
    ORDER BY c.communication_date DESC
  `;
  
  const communicationsResult = await client.query(communicationsQuery, [
    request.lease_id,
    request.tenant_id,
    request.requested_date,
  ]);

    // Parse updates from management_notes if they exist
    const managementUpdates = [];
    if (request.management_notes) {
      const noteLines = request.management_notes.split("\n");
      noteLines.forEach((line) => {
        const match = line.match(/^\[(\d{4}-\d{2}-\d{2}) - ([^\]]+)\]: (.+)$/);
        if (match) {
          managementUpdates.push({
            date: match[1] + "T00:00:00Z",
            author: match[2],
            content: match[3],
            source: "management_notes",
          });
        }
      });
    }

    // Combine communications and management note updates (legacy support)
    const allUpdates = [
      ...communicationsResult.rows.map((comm) => ({
        date: comm.communication_date,
        author: comm.staff_member || "Tenant",
        content: comm.message_content,
        source: "communication",
        direction: comm.direction,
      })),
      ...managementUpdates,
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Format the response
    const formattedRequest = {
      id: request.id,
      title: request.request_title,
      description: request.description,
      priority: request.priority,
      category: request.category,
      status: request.status,
      requestedDate: request.requested_date,
      scheduledDate: request.scheduled_date,
      completedDate: request.completed_date,
      estimatedCost: parseFloat(request.estimated_cost) || 0,
      actualCost: parseFloat(request.actual_cost) || 0,
      assignedTo: request.assigned_to,
      assignedToName: request.assigned_to_name,
      tenantNotes: request.tenant_notes,
      managementNotes: request.management_notes,

      // Property details
      property: {
        id: request.property_id,
        name: request.property_name,
        address: request.property_address,
      },

      // Unit details
      unit: {
        id: request.unit_id,
        number: request.unit_number,
      },

      // Tenant details
      tenant: {
        id: request.tenant_id,
        name: request.tenant_name,
        phone: request.tenant_phone,
        email: request.tenant_email,
      },

      // Lease details
      lease: {
        id: request.lease_id,
        number: request.lease_number,
      },

      // Updates from maintenance_request_updates table (primary source)
      updates: request.updates || [],

      // Photos
      photos: request.photos || [],
      photoCount: request.photos ? request.photos.length : 0,

      // Legacy updates from communications and management notes
      legacyUpdates: allUpdates.map((update) => ({
        date: update.date,
        author: update.author,
        content: update.content,
        source: update.source,
      })),

      // Frontend compatibility
      propertyName: request.property_name,
      tenantName: request.tenant_name,
      tenantContact: request.tenant_phone,
      dateSubmitted: request.requested_date?.toISOString().split("T")[0],
      createdAt: request.requested_date,
    };

    res.status(200).json({
      status: 200,
      message: "Maintenance request retrieved successfully",
      data: formattedRequest,
    });
  } catch (error) {
    console.error("Maintenance request fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch maintenance request",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Create new maintenance request
// Create new maintenance request
router.post("/", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      title,
      description,
      priority = "medium",
      category,
      unitId,
      tenantId, // Admin can specify which tenant this is for
      leaseId,
      requestedDate = new Date(),
      tenantNotes,
      managementNotes,
      estimatedCost,
      photos = [],
    } = req.body;

    // Validate required fields
    if (!title || !description || !unitId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: "Title, description, and unit ID are required",
      });
    }

    // Helper function to convert empty strings to null for integer fields
    const toIntOrNull = (value) => {
      if (value === null || value === undefined || value === "") {
        return null;
      }
      const parsed = parseInt(value);
      return isNaN(parsed) ? null : parsed;
    };

    // Helper function to convert empty strings to null for decimal fields
    const toDecimalOrNull = (value) => {
      if (value === null || value === undefined || value === "") {
        return null;
      }
      const parsed = parseFloat(value);
      return isNaN(parsed) ? null : parsed;
    };

    // Convert and validate unitId
    const validUnitId = toIntOrNull(unitId);
    if (!validUnitId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: "Valid unit ID is required",
      });
    }

    // Verify unit exists and get property info
    const unitCheck = await client.query(
      `SELECT u.id, u.unit_number, p.id as property_id, p.property_name 
         FROM units u 
         JOIN properties p ON u.property_id = p.id 
         WHERE u.id = $1`,
      [validUnitId]
    );

    if (unitCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Unit not found",
      });
    }

    const unitInfo = unitCheck.rows[0];

    // Determine tenant and lease IDs based on user role
    let finalTenantId = toIntOrNull(tenantId);
    let finalLeaseId = toIntOrNull(leaseId);

    console.log('🔍 Initial tenant/lease values:', { 
      receivedTenantId: tenantId, 
      finalTenantId, 
      receivedLeaseId: leaseId, 
      finalLeaseId,
      userRole: req.user.role_name
    });

    // If user is a tenant, use their tenant ID
    if (req.user.tenant_id) {
      finalTenantId = req.user.tenant_id;
      console.log('👤 User is tenant - using their tenant ID:', finalTenantId);
    }

    // If tenantId was provided (admin specifying tenant), validate it exists
    if (finalTenantId && !req.user.tenant_id) {
      const tenantCheck = await client.query(
        "SELECT id, first_name, last_name FROM tenants WHERE id = $1",
        [finalTenantId]
      );

      if (tenantCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Invalid tenant ID provided",
        });
      }
      
      console.log('✅ Tenant validated:', tenantCheck.rows[0].first_name, tenantCheck.rows[0].last_name);
    }

    // Try to find active lease for the unit and tenant (if we have a tenant)
    if (finalTenantId && !finalLeaseId) {
      const leaseQuery = `
          SELECT l.id, l.lease_number
          FROM leases l
          JOIN lease_tenants lt ON l.id = lt.lease_id
          WHERE l.unit_id = $1 AND lt.tenant_id = $2 AND l.lease_status = 'active'
          AND lt.removed_date IS NULL
          LIMIT 1
        `;

      const leaseResult = await client.query(leaseQuery, [
        validUnitId,
        finalTenantId,
      ]);
      if (leaseResult.rows.length > 0) {
        finalLeaseId = leaseResult.rows[0].id;
        console.log('✅ Found active lease for tenant:', leaseResult.rows[0].lease_number);
      }
    }

    // If admin is creating and no specific tenant provided,
    // try to find current tenant for the unit
    if (
      !finalTenantId &&
      ["Super Admin", "Admin", "Manager", "Staff"].includes(req.user.role_name)
    ) {
      console.log('🔍 Admin creating request without tenant specified - attempting auto-detection for unit:', validUnitId);
      
      const currentTenantQuery = `
        SELECT 
          lt.tenant_id, 
          l.id as lease_id, 
          t.first_name, 
          t.last_name,
          t.email,
          lt.is_primary_tenant
        FROM leases l
        JOIN lease_tenants lt ON l.id = lt.lease_id
        JOIN tenants t ON lt.tenant_id = t.id
        WHERE l.unit_id = $1 
          AND l.lease_status = 'active'
          AND lt.removed_date IS NULL
        ORDER BY lt.is_primary_tenant DESC, lt.tenant_id ASC
        LIMIT 1
      `;

      const currentTenantResult = await client.query(currentTenantQuery, [
        validUnitId,
      ]);
      
      if (currentTenantResult.rows.length > 0) {
        finalTenantId = currentTenantResult.rows[0].tenant_id;
        finalLeaseId = currentTenantResult.rows[0].lease_id;
        console.log(
          `✅ Auto-detected tenant: ${currentTenantResult.rows[0].first_name} ${currentTenantResult.rows[0].last_name} (ID: ${finalTenantId}, Lease: ${finalLeaseId})`
        );
      } else {
        console.log("⚠️ No active tenant found for unit - creating request without tenant assignment");
      }
    }

    // Log final values being used
    console.log('📝 Final values for maintenance request:', {
      unitId: validUnitId,
      tenantId: finalTenantId,
      leaseId: finalLeaseId,
      hasExplicitTenant: !!tenantId,
      isAutoDetected: !tenantId && !!finalTenantId,
      userRole: req.user.role_name,
      userId: req.user.id
    });

    // Process estimated cost
    const validEstimatedCost = toDecimalOrNull(estimatedCost);

    // Create maintenance request with proper null handling
    const createQuery = `
        INSERT INTO maintenance_requests (
          unit_id, tenant_id, lease_id, request_title, description,
          priority, category, status, requested_date, estimated_cost,
          tenant_notes, management_notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `;

    console.log("📊 Creating maintenance request with values:", {
      unitId: validUnitId,
      tenantId: finalTenantId,
      leaseId: finalLeaseId,
      title,
      description,
      priority,
      category,
      estimatedCost: validEstimatedCost,
      userRole: req.user.role_name,
      userId: req.user.id,
      userName: req.user.username
    });

    const result = await client.query(createQuery, [
      validUnitId, // $1 - unit_id (integer)
      finalTenantId, // $2 - tenant_id (integer or null)
      finalLeaseId, // $3 - lease_id (integer or null)
      title, // $4 - request_title (varchar)
      description, // $5 - description (text)
      priority, // $6 - priority (varchar)
      category, // $7 - category (varchar)
      "open", // $8 - status (varchar)
      requestedDate, // $9 - requested_date (timestamp)
      validEstimatedCost, // $10 - estimated_cost (decimal or null)
      tenantNotes || null, // $11 - tenant_notes (text or null)
      managementNotes || null, // $12 - management_notes (text or null)
    ]);

    const newRequest = result.rows[0];

    console.log('✅ Maintenance request created successfully with ID:', newRequest.id);

    // Log activity with different descriptions based on user role
    let activityDescription;
    if (req.user.tenant_id) {
      activityDescription = `Tenant created maintenance request: ${title} for ${unitInfo.property_name} Unit ${unitInfo.unit_number}`;
    } else {
      activityDescription = `Admin created maintenance request: ${title} for ${unitInfo.property_name} Unit ${unitInfo.unit_number}${finalTenantId ? " (assigned to tenant ID: " + finalTenantId + ")" : " (no tenant assigned)"}`;
    }

    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        "maintenance_request_created",
        activityDescription,
        "maintenance_request",
        newRequest.id,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    // Create initial communication record ONLY if we have tenant_id or lease_id
    if (finalTenantId || finalLeaseId) {
      try {
        const communicationDirection = req.user.tenant_id
          ? "inbound"
          : "outbound";
        const staffMember = req.user.tenant_id ? null : req.user.username;

        await client.query(
          `INSERT INTO communications (
              tenant_id, lease_id, communication_type, subject, message_content,
              direction, communication_date, staff_member
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            finalTenantId, // Can be null
            finalLeaseId, // Can be null
            "Other",
            `Maintenance Request Created: ${title}`,
            req.user.tenant_id
              ? `New maintenance request submitted: ${description}`
              : `Maintenance request created by ${req.user.username}: ${description}`,
            communicationDirection,
            requestedDate,
            staffMember,
          ]
        );
        console.log('✅ Communication record created');
      } catch (commError) {
        console.warn(
          "⚠️ Failed to create communication record, but continuing:",
          commError.message
        );
        // Don't fail the entire request if communication creation fails
      }
    } else {
      console.log(
        "ℹ️ Skipping communication record creation - no tenant_id or lease_id available (admin-created for vacant unit)"
      );
    }

    await client.query("COMMIT");

    // Get the created request with related info for response
    const responseQuery = `
        SELECT 
          mr.*,
          p.property_name,
          u.unit_number,
          t.first_name || ' ' || t.last_name as tenant_name,
          t.phone as tenant_phone,
          t.email as tenant_email,
          l.lease_number
        FROM maintenance_requests mr
        JOIN units u ON mr.unit_id = u.id
        JOIN properties p ON u.property_id = p.id
        LEFT JOIN tenants t ON mr.tenant_id = t.id
        LEFT JOIN leases l ON mr.lease_id = l.id
        WHERE mr.id = $1
      `;

    const responseResult = await client.query(responseQuery, [newRequest.id]);
    const formattedRequest = responseResult.rows[0];

    console.log('📤 Sending response with tenant:', formattedRequest.tenant_name || 'None');

    // CRITICAL FIX: Return ID in multiple formats for photo upload compatibility
    res.status(201).json({
      status: 201,
      message: "Maintenance request created successfully",
      data: {
        id: formattedRequest.id,  // ✅ Direct access: response.data.id
        requestId: formattedRequest.id,  // ✅ Alternative: response.data.requestId
        request: {  // ✅ Nested access: response.data.request.id
          id: formattedRequest.id,
          title: formattedRequest.request_title,
          description: formattedRequest.description,
          priority: formattedRequest.priority,
          category: formattedRequest.category,
          status: formattedRequest.status,
          createdAt: formattedRequest.requested_date,
          unitId: formattedRequest.unit_id,
          tenantId: formattedRequest.tenant_id,
          leaseId: formattedRequest.lease_id,
          property: formattedRequest.property_name,
          unit: formattedRequest.unit_number,
          tenantName: formattedRequest.tenant_name,
          tenantContact: formattedRequest.tenant_phone,
          tenantEmail: formattedRequest.tenant_email,
          leaseNumber: formattedRequest.lease_number,
          estimatedCost: parseFloat(formattedRequest.estimated_cost) || 0,
          tenantNotes: formattedRequest.tenant_notes,
          managementNotes: formattedRequest.management_notes,
          requestedDate: formattedRequest.requested_date
        },
        // Additional top-level fields for backward compatibility
        title: formattedRequest.request_title,
        description: formattedRequest.description,
        priority: formattedRequest.priority,
        category: formattedRequest.category,
        status: formattedRequest.status,
        createdAt: formattedRequest.requested_date,
        unitId: formattedRequest.unit_id,
        tenantId: formattedRequest.tenant_id,
        leaseId: formattedRequest.lease_id,
        property: formattedRequest.property_name,
        unit: formattedRequest.unit_number,
        tenantName: formattedRequest.tenant_name,
        tenantContact: formattedRequest.tenant_phone,
        tenantEmail: formattedRequest.tenant_email,
        leaseNumber: formattedRequest.lease_number,
        estimatedCost: parseFloat(formattedRequest.estimated_cost) || 0,
        updates: [],
        createdBy: req.user.username,
        createdByRole: req.user.role_name,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Maintenance request creation error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to create maintenance request",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});
// Update maintenance request status and details
router.put("/:id", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requestId = req.params.id;
    const {
      status,
      priority,
      assignedTo,
      scheduledDate,
      completedDate,
      estimatedCost,
      actualCost,
      managementNotes,
      updateNotes,
    } = req.body;

    // Check if request exists
    const requestCheck = await client.query(
      "SELECT * FROM maintenance_requests WHERE id = $1",
      [requestId]
    );

    if (requestCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Maintenance request not found",
      });
    }

    const existingRequest = requestCheck.rows[0];

    // Build dynamic update query
    const updateFields = [];
    const updateValues = [];
    let paramIndex = 1;

    if (status !== undefined) {
      updateFields.push(`status = $${paramIndex}`);
      updateValues.push(status);
      paramIndex++;
    }

    if (priority !== undefined) {
      updateFields.push(`priority = $${paramIndex}`);
      updateValues.push(priority);
      paramIndex++;
    }

    if (assignedTo !== undefined) {
      updateFields.push(`assigned_to = $${paramIndex}`);
      updateValues.push(assignedTo);
      paramIndex++;
    }

    if (scheduledDate !== undefined) {
      updateFields.push(`scheduled_date = $${paramIndex}`);
      updateValues.push(scheduledDate);
      paramIndex++;
    }

    if (completedDate !== undefined) {
      updateFields.push(`completed_date = $${paramIndex}`);
      updateValues.push(completedDate);
      paramIndex++;
    }

    if (estimatedCost !== undefined) {
      updateFields.push(`estimated_cost = $${paramIndex}`);
      updateValues.push(estimatedCost);
      paramIndex++;
    }

    if (actualCost !== undefined) {
      updateFields.push(`actual_cost = $${paramIndex}`);
      updateValues.push(actualCost);
      paramIndex++;
    }

    if (managementNotes !== undefined) {
      updateFields.push(`management_notes = $${paramIndex}`);
      updateValues.push(managementNotes);
      paramIndex++;
    }

    if (updateFields.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: "No valid fields to update",
      });
    }

    // Add the request ID and timestamp
    updateValues.push(requestId);
    const updateQuery = `
        UPDATE maintenance_requests 
        SET ${updateFields.join(", ")}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramIndex}
        RETURNING *
      `;

    const updateResult = await client.query(updateQuery, updateValues);
    const updatedRequest = updateResult.rows[0];

    // Create communication record for the update
    if (updateNotes) {
      await client.query(
        `INSERT INTO communications (
            tenant_id, lease_id, communication_type, subject, message_content,
            direction, communication_date, staff_member
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          existingRequest.tenant_id,
          existingRequest.lease_id,
          "Other",
          `Maintenance Request Update: ${existingRequest.request_title}`,
          updateNotes,
          "outbound",
          new Date(),
          req.user.username,
        ]
      );
    }

    // Log activity with detailed change description
    const changeDescription = [];
    if (status && status !== existingRequest.status) {
      changeDescription.push(
        `Status changed from ${existingRequest.status} to ${status}`
      );
    }
    if (assignedTo && assignedTo !== existingRequest.assigned_to) {
      changeDescription.push(`Assigned to ${assignedTo}`);
    }
    if (priority && priority !== existingRequest.priority) {
      changeDescription.push(`Priority changed to ${priority}`);
    }

    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        "maintenance_request_updated",
        `Updated maintenance request: ${existingRequest.request_title}. ${changeDescription.join(", ")}`,
        "maintenance_request",
        requestId,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    await client.query("COMMIT");

    res.status(200).json({
      status: 200,
      message: "Maintenance request updated successfully",
      data: {
        id: updatedRequest.id,
        title: updatedRequest.request_title,
        status: updatedRequest.status,
        priority: updatedRequest.priority,
        assignedTo: updatedRequest.assigned_to,
        scheduledDate: updatedRequest.scheduled_date,
        completedDate: updatedRequest.completed_date,
        estimatedCost: parseFloat(updatedRequest.estimated_cost) || 0,
        actualCost: parseFloat(updatedRequest.actual_cost) || 0,
        managementNotes: updatedRequest.management_notes,
        updatedAt: updatedRequest.updated_at,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Maintenance request update error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to update maintenance request",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Add update/comment to maintenance request
router.post("/:id/updates", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { updateText, updateType, isInternal } = req.body;

    // ✅ FIX: Convert id from string to integer
    const requestId = parseInt(id);
    
    if (isNaN(requestId)) {
      return res.status(400).json({
        status: 400,
        message: "Invalid maintenance request ID"
      });
    }

    console.log('📝 Received update request:', {
      requestId: requestId,
      updateText: updateText,
      updateType: updateType,
      isInternal: isInternal,
      userId: req.user.id
    });

    // Validate required fields
    if (!updateText || !updateText.trim()) {
      return res.status(400).json({
        status: 400,
        message: "Update content is required"
      });
    }

    // Verify maintenance request exists
    const requestCheck = await client.query(
      "SELECT id, request_title FROM maintenance_requests WHERE id = $1",
      [requestId]  // ✅ Use integer instead of string
    );

    if (requestCheck.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Maintenance request not found"
      });
    }

    // Insert the update
    const insertQuery = `
      INSERT INTO maintenance_request_updates 
      (maintenance_request_id, update_text, update_type, is_internal, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING *
    `;

    const result = await client.query(insertQuery, [
      requestId,  // ✅ Use integer instead of string
      updateText.trim(),
      updateType || 'general',
      isInternal || false,
      req.user.id
    ]);

    const newUpdate = result.rows[0];

    console.log('✅ Update created with ID:', newUpdate.id);

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        'maintenance_update_added',
        `Added update to maintenance request #${requestId}: ${updateText.substring(0, 50)}${updateText.length > 50 ? '...' : ''}`,
        'maintenance_request',
        requestId,  // ✅ Use integer instead of string
        req.ip,
        req.headers['user-agent']
      ]
    );

    // Get the complete update with user info
    const detailQuery = `
      SELECT 
        mru.*,
        u.first_name || ' ' || u.last_name as created_by_name,
        u.username
      FROM maintenance_request_updates mru
      LEFT JOIN users u ON mru.created_by = u.id
      WHERE mru.id = $1
    `;

    const detailResult = await client.query(detailQuery, [newUpdate.id]);

    res.status(201).json({
      status: 201,
      message: "Update added successfully",
      data: detailResult.rows[0]
    });

  } catch (error) {
    console.error("❌ Error adding maintenance update:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to add update",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Delete maintenance request (soft delete - change status to cancelled)
router.delete("/:id", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const requestId = req.params.id;
    const { reason = "Request cancelled by management" } = req.body;

    // Check if request exists
    const requestCheck = await client.query(
      "SELECT * FROM maintenance_requests WHERE id = $1",
      [requestId]
    );

    if (requestCheck.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Maintenance request not found",
      });
    }

    const existingRequest = requestCheck.rows[0];

    // Update status to cancelled instead of deleting
    const result = await client.query(
      `UPDATE maintenance_requests 
         SET status = 'cancelled', management_notes = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
      [reason, requestId]
    );

    // Create communication record for cancellation
    await client.query(
      `INSERT INTO communications (
          tenant_id, lease_id, communication_type, subject, message_content,
          direction, communication_date, staff_member
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        existingRequest.tenant_id,
        existingRequest.lease_id,
        "Other",
        `Maintenance Request Cancelled: ${existingRequest.request_title}`,
        reason,
        "outbound",
        new Date(),
        req.user.username,
      ]
    );

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
         (user_id, activity_type, activity_description, affected_resource_type, affected_resource_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        "maintenance_request_cancelled",
        `Cancelled maintenance request: ${existingRequest.request_title}. Reason: ${reason}`,
        "maintenance_request",
        requestId,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    res.status(200).json({
      status: 200,
      message: "Maintenance request cancelled successfully",
      data: {
        id: requestId,
        status: "cancelled",
        reason: reason,
        cancelledAt: new Date(),
      },
    });
  } catch (error) {
    console.error("Maintenance request cancellation error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to cancel maintenance request",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get maintenance requests by tenant
router.get("/tenant/:tenantId", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const tenantId = req.params.tenantId;

    // Check if user has permission to view this tenant's requests
    if (req.user.tenant_id && req.user.tenant_id != tenantId) {
      return res.status(403).json({
        status: 403,
        message: "Access denied: Cannot view other tenant requests",
      });
    }

    const requestsQuery = `
        SELECT 
          mr.*,
          p.property_name,
          u.unit_number,
          l.lease_number
        FROM maintenance_requests mr
        JOIN units u ON mr.unit_id = u.id
        JOIN properties p ON u.property_id = p.id
        LEFT JOIN leases l ON mr.lease_id = l.id
        WHERE mr.tenant_id = $1
        ORDER BY mr.requested_date DESC
      `;

    const result = await client.query(requestsQuery, [tenantId]);

    const formattedRequests = result.rows.map((request) => ({
      id: request.id,
      title: request.request_title,
      description: request.description,
      priority: request.priority,
      category: request.category,
      status: request.status,
      requestedDate: request.requested_date,
      scheduledDate: request.scheduled_date,
      completedDate: request.completed_date,
      propertyName: request.property_name,
      unitNumber: request.unit_number,
      leaseNumber: request.lease_number,
      estimatedCost: parseFloat(request.estimated_cost) || 0,
      actualCost: parseFloat(request.actual_cost) || 0,
      assignedTo: request.assigned_to,
    }));

    res.status(200).json({
      status: 200,
      message: "Tenant maintenance requests retrieved successfully",
      data: {
        tenantId,
        requests: formattedRequests,
        totalRequests: formattedRequests.length,
      },
    });
  } catch (error) {
    console.error("Tenant maintenance requests fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch tenant maintenance requests",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get maintenance requests by property
router.get(
  "/property/:propertyId",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const propertyId = req.params.propertyId;

      const requestsQuery = `
        SELECT 
          mr.*,
          p.property_name,
          u.unit_number,
          t.first_name || ' ' || t.last_name as tenant_name,
          l.lease_number
        FROM maintenance_requests mr
        JOIN units u ON mr.unit_id = u.id
        JOIN properties p ON u.property_id = p.id
        LEFT JOIN tenants t ON mr.tenant_id = t.id
        LEFT JOIN leases l ON mr.lease_id = l.id
        WHERE p.id = $1
        ORDER BY mr.requested_date DESC
      `;

      const result = await client.query(requestsQuery, [propertyId]);

      const formattedRequests = result.rows.map((request) => ({
        id: request.id,
        title: request.request_title,
        description: request.description,
        priority: request.priority,
        category: request.category,
        status: request.status,
        requestedDate: request.requested_date,
        propertyName: request.property_name,
        unitNumber: request.unit_number,
        tenantName: request.tenant_name,
        assignedTo: request.assigned_to,
        estimatedCost: parseFloat(request.estimated_cost) || 0,
        actualCost: parseFloat(request.actual_cost) || 0,
      }));

      res.status(200).json({
        status: 200,
        message: "Property maintenance requests retrieved successfully",
        data: {
          propertyId,
          requests: formattedRequests,
          totalRequests: formattedRequests.length,
        },
      });
    } catch (error) {
      console.error("Property maintenance requests fetch error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to fetch property maintenance requests",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Get available units for maintenance request creation
router.get("/units/available", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const unitsQuery = `
        SELECT 
          u.id,
          u.unit_number,
          u.occupancy_status,
          p.id as property_id,
          p.property_name,
          p.address,
          
          -- Get current tenant info if occupied
          CASE 
            WHEN u.occupancy_status = 'occupied' THEN
              (SELECT t.first_name || ' ' || t.last_name 
               FROM lease_tenants lt 
               JOIN leases l ON lt.lease_id = l.id 
               JOIN tenants t ON lt.tenant_id = t.id 
               WHERE l.unit_id = u.id 
               AND l.lease_status = 'active' 
               AND lt.removed_date IS NULL 
               AND lt.is_primary_tenant = true
               LIMIT 1)
            ELSE NULL
          END as current_tenant_name,
          
          CASE 
            WHEN u.occupancy_status = 'occupied' THEN
              (SELECT t.id 
               FROM lease_tenants lt 
               JOIN leases l ON lt.lease_id = l.id 
               JOIN tenants t ON lt.tenant_id = t.id 
               WHERE l.unit_id = u.id 
               AND l.lease_status = 'active' 
               AND lt.removed_date IS NULL 
               AND lt.is_primary_tenant = true
               LIMIT 1)
            ELSE NULL
          END as current_tenant_id,
          
          CASE 
            WHEN u.occupancy_status = 'occupied' THEN
              (SELECT l.id 
               FROM leases l 
               WHERE l.unit_id = u.id 
               AND l.lease_status = 'active'
               LIMIT 1)
            ELSE NULL
          END as current_lease_id
          
        FROM units u
        JOIN properties p ON u.property_id = p.id
        ORDER BY p.property_name, u.unit_number
      `;

    const result = await client.query(unitsQuery);

    const formattedUnits = result.rows.map((unit) => ({
      id: unit.id,
      unitNumber: unit.unit_number,
      occupancyStatus: unit.occupancy_status,
      property: {
        id: unit.property_id,
        name: unit.property_name,
        address: unit.address,
      },
      currentTenant: unit.current_tenant_name
        ? {
            id: unit.current_tenant_id,
            name: unit.current_tenant_name,
          }
        : null,
      currentLeaseId: unit.current_lease_id,
      displayName: `${unit.property_name} - Unit ${unit.unit_number}${unit.current_tenant_name ? ` (${unit.current_tenant_name})` : ""}`,
    }));

    res.status(200).json({
      status: 200,
      message: "Available units retrieved successfully",
      data: {
        units: formattedUnits,
        totalUnits: formattedUnits.length,
      },
    });
  } catch (error) {
    console.error("Units fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch units",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get maintenance categories and priorities (for form dropdowns)
router.get("/metadata/options", authenticateTokenSimple, async (req, res) => {
  try {
    const metadata = {
      categories: [
        "Plumbing",
        "Electrical",
        "HVAC",
        "Appliances",
        "Structural",
        "Pest Control",
        "Cleaning",
        "Security",
        "Other",
      ],
      priorities: ["low", "medium", "high", "emergency"],
      statuses: ["open", "in_progress", "completed", "cancelled", "on_hold"],
    };

    res.status(200).json({
      status: 200,
      message: "Maintenance metadata retrieved successfully",
      data: metadata,
    });
  } catch (error) {
    console.error("Metadata fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch metadata",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Get maintenance statistics/dashboard data
router.get("/stats/dashboard", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const { timeframe = "30" } = req.query; // days

    const statsQuery = `
        WITH request_stats AS (
          SELECT 
            COUNT(*) as total_requests,
            COUNT(CASE WHEN status = 'open' THEN 1 END) as open_requests,
            COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress_requests,
            COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_requests,
            COUNT(CASE WHEN priority = 'high' THEN 1 END) as high_priority_requests,
            COUNT(CASE WHEN priority = 'emergency' THEN 1 END) as emergency_requests,
            AVG(CASE WHEN actual_cost IS NOT NULL THEN actual_cost END) as avg_cost,
            SUM(CASE WHEN actual_cost IS NOT NULL THEN actual_cost ELSE 0 END) as total_cost
          FROM maintenance_requests 
          WHERE requested_date >= CURRENT_DATE - INTERVAL '${timeframe} days'
        ),
        category_stats AS (
          SELECT 
            category,
            COUNT(*) as count
          FROM maintenance_requests 
          WHERE requested_date >= CURRENT_DATE - INTERVAL '${timeframe} days'
          GROUP BY category
          ORDER BY count DESC
        ),
        recent_requests AS (
          SELECT 
            mr.id,
            mr.request_title,
            mr.priority,
            mr.status,
            mr.requested_date,
            p.property_name,
            u.unit_number
          FROM maintenance_requests mr
          JOIN units u ON mr.unit_id = u.id
          JOIN properties p ON u.property_id = p.id
          WHERE mr.requested_date >= CURRENT_DATE - INTERVAL '7 days'
          ORDER BY mr.requested_date DESC
          LIMIT 5
        )
        SELECT 
          (SELECT row_to_json(request_stats) FROM request_stats) as request_stats,
          (SELECT json_agg(category_stats) FROM category_stats) as category_stats,
          (SELECT json_agg(recent_requests) FROM recent_requests) as recent_requests
      `;

    const result = await client.query(statsQuery);
    const data = result.rows[0];

    res.status(200).json({
      status: 200,
      message: "Dashboard statistics retrieved successfully",
      data: {
        summary: data.request_stats,
        categoryBreakdown: data.category_stats || [],
        recentRequests: data.recent_requests || [],
        timeframe: `${timeframe} days`,
      },
    });
  } catch (error) {
    console.error("Dashboard stats fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch dashboard statistics",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Upload photos for a maintenance request
router.post(
  "/:id/photos",
  authenticateTokenSimple,
  upload.array("photos", 10),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const { id } = req.params;
      const { description, is_before_photo } = req.body;
      const uploadedFiles = req.files;

      if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({
          status: 400,
          message: "No photos uploaded",
        });
      }

      // Verify maintenance request exists
      const requestCheck = await client.query(
        "SELECT id FROM maintenance_requests WHERE id = $1",
        [id]
      );

      if (requestCheck.rows.length === 0) {
        // Delete uploaded files if request doesn't exist
        uploadedFiles.forEach((file) => {
          fs.unlinkSync(file.path);
        });

        return res.status(404).json({
          status: 404,
          message: "Maintenance request not found",
        });
      }

      // Insert photo records
      const insertedPhotos = [];
      for (const file of uploadedFiles) {
        const photoQuery = `
        INSERT INTO maintenance_request_photos 
        (maintenance_request_id, file_name, file_path, file_size, mime_type, uploaded_by, description, is_before_photo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;

        const result = await client.query(photoQuery, [
          id,
          file.originalname,
          file.path,
          file.size,
          file.mimetype,
          req.user.id,
          description || null,
          is_before_photo === "true" || is_before_photo === true,
        ]);

        insertedPhotos.push(result.rows[0]);
      }

      // Log activity
      await client.query(
        `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
        [
          req.user.id,
          "maintenance_photos_uploaded",
          `Uploaded ${uploadedFiles.length} photo(s) for maintenance request #${id}`,
          req.ip,
          req.headers["user-agent"],
        ]
      );

      res.status(201).json({
        status: 201,
        message: "Photos uploaded successfully",
        data: {
          photos: insertedPhotos,
          count: insertedPhotos.length,
        },
      });
    } catch (error) {
      console.error("Photo upload error:", error);

      // Delete uploaded files on error
      if (req.files) {
        req.files.forEach((file) => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }

      res.status(500).json({
        status: 500,
        message: "Failed to upload photos",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Get photos for a maintenance request
router.get("/:id/photos", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const photosQuery = `
      SELECT 
        p.id,
        p.file_name,
        p.file_path,
        p.file_size,
        p.mime_type,
        p.uploaded_at,
        p.description,
        p.is_before_photo,
        u.first_name || ' ' || u.last_name as uploaded_by_name
      FROM maintenance_request_photos p
      LEFT JOIN users u ON p.uploaded_by = u.id
      WHERE p.maintenance_request_id = $1
      ORDER BY p.display_order, p.uploaded_at DESC
    `;

    const result = await client.query(photosQuery, [id]);

    res.status(200).json({
      status: 200,
      message: "Photos retrieved successfully",
      data: {
        photos: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error("Photos fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch photos",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Delete a photo
router.delete("/photos/:photoId", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const { photoId } = req.params;

    // Get photo details
    const photoQuery = await client.query(
      "SELECT * FROM maintenance_request_photos WHERE id = $1",
      [photoId]
    );

    if (photoQuery.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Photo not found",
      });
    }

    const photo = photoQuery.rows[0];

    // Delete file from filesystem
    if (fs.existsSync(photo.file_path)) {
      fs.unlinkSync(photo.file_path);
    }

    // Delete database record
    await client.query("DELETE FROM maintenance_request_photos WHERE id = $1", [
      photoId,
    ]);

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        "maintenance_photo_deleted",
        `Deleted photo ${photo.file_name}`,
        req.ip,
        req.headers["user-agent"],
      ]
    );

    res.status(200).json({
      status: 200,
      message: "Photo deleted successfully",
    });
  } catch (error) {
    console.error("Photo delete error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to delete photo",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Serve photo file (public - no auth required for img tags)
router.get(
  "/photos/:photoId/file",
  async (req, res) => {
    const client = await pool.connect();

    try {
      const { photoId } = req.params;

      const photoQuery = await client.query(
        "SELECT file_path, mime_type, file_name FROM maintenance_request_photos WHERE id = $1",
        [photoId]
      );

      if (photoQuery.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Photo not found",
        });
      }

      const photo = photoQuery.rows[0];

      if (!fs.existsSync(photo.file_path)) {
        return res.status(404).json({
          status: 404,
          message: "Photo file not found on server",
        });
      }

      // Set CORS headers to allow cross-origin image loading
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Content-Type", photo.mime_type);
      res.sendFile(path.resolve(photo.file_path));
    } catch (error) {
      console.error("Photo serve error:", error);

      res.status(500).json({
        status: 500,
        message: "Failed to serve photo",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

export default router;