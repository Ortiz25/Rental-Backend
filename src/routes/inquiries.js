import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/inquiries
 * Get all property inquiries with statistics
 * Accessible by: Admin, Manager, Staff
 */
router.get(
  "/",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin", "Manager", "Staff"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      // Get all inquiries with property and user details
      const query = `
        SELECT 
          pi.id,
          pi.property_id,
          pi.unit_id,
          pi.inquirer_name,
          pi.inquirer_email,
          pi.inquirer_phone,
          pi.message,
          pi.preferred_contact_method,
          pi.preferred_move_in_date,
          pi.inquiry_status,
          pi.response_notes,
          pi.contacted_at,
          pi.scheduled_viewing_at,
          pi.created_at,
          pi.updated_at,
          p.property_name,
          p.address as property_address,
          p.property_type,
          u.unit_number,
          pi.assigned_to,
          CONCAT(usr.first_name, ' ', usr.last_name) as assigned_to_name,
          pi.submitted_by,
          CONCAT(sub.first_name, ' ', sub.last_name) as submitted_by_name
        FROM property_inquiries pi
        JOIN properties p ON pi.property_id = p.id
        LEFT JOIN units u ON pi.unit_id = u.id
        LEFT JOIN users usr ON pi.assigned_to = usr.id
        LEFT JOIN users sub ON pi.submitted_by = sub.id
        ORDER BY 
          CASE 
            WHEN pi.inquiry_status = 'pending' THEN 1
            WHEN pi.inquiry_status = 'contacted' THEN 2
            WHEN pi.inquiry_status = 'scheduled' THEN 3
            WHEN pi.inquiry_status = 'completed' THEN 4
            ELSE 5
          END,
          pi.created_at DESC
      `;

      const result = await client.query(query);

      // Calculate statistics
      const stats = {
        total: result.rows.length,
        pending: result.rows.filter((i) => i.inquiry_status === "pending").length,
        contacted: result.rows.filter((i) => i.inquiry_status === "contacted").length,
        scheduled: result.rows.filter((i) => i.inquiry_status === "scheduled").length,
        completed: result.rows.filter((i) => i.inquiry_status === "completed").length,
        rejected: result.rows.filter((i) => i.inquiry_status === "rejected").length,
        cancelled: result.rows.filter((i) => i.inquiry_status === "cancelled").length,
      };

      res.status(200).json({
        status: 200,
        message: "Inquiries retrieved successfully",
        data: {
          inquiries: result.rows,
          stats: stats,
        },
      });
    } catch (error) {
      console.error("Inquiries fetch error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch inquiries",
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /api/inquiries/:id
 * Get a specific inquiry by ID
 * Accessible by: Admin, Manager, Staff
 */
router.get(
  "/:id",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin", "Manager", "Staff"]),
  async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;

    try {
      const query = `
        SELECT 
          pi.*,
          p.property_name,
          p.address as property_address,
          p.property_type,
          u.unit_number,
          CONCAT(usr.first_name, ' ', usr.last_name) as assigned_to_name,
          CONCAT(sub.first_name, ' ', sub.last_name) as submitted_by_name
        FROM property_inquiries pi
        JOIN properties p ON pi.property_id = p.id
        LEFT JOIN units u ON pi.unit_id = u.id
        LEFT JOIN users usr ON pi.assigned_to = usr.id
        LEFT JOIN users sub ON pi.submitted_by = sub.id
        WHERE pi.id = $1
      `;

      const result = await client.query(query, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Inquiry not found",
        });
      }

      res.status(200).json({
        status: 200,
        message: "Inquiry retrieved successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Inquiry fetch error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch inquiry",
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

/**
 * PATCH /api/inquiries/:id
 * Update an inquiry
 * Accessible by: Admin, Manager, Staff
 */
router.patch(
  "/:id",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin", "Manager", "Staff"]),
  async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const {
      status,
      assignedTo,
      responseNotes,
      contactedAt,
      scheduledViewingAt,
    } = req.body;

    try {
      await client.query("BEGIN");

      // Build update query dynamically
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (status !== undefined) {
        updates.push(`inquiry_status = $${paramIndex}`);
        values.push(status);
        paramIndex++;
      }

      if (assignedTo !== undefined) {
        updates.push(`assigned_to = $${paramIndex}`);
        values.push(assignedTo || null);
        paramIndex++;
      }

      if (responseNotes !== undefined) {
        updates.push(`response_notes = $${paramIndex}`);
        values.push(responseNotes);
        paramIndex++;
      }

      if (contactedAt !== undefined) {
        updates.push(`contacted_at = $${paramIndex}`);
        values.push(contactedAt || null);
        paramIndex++;
      }

      if (scheduledViewingAt !== undefined) {
        updates.push(`scheduled_viewing_at = $${paramIndex}`);
        values.push(scheduledViewingAt || null);
        paramIndex++;
      }

      if (updates.length === 0) {
        return res.status(400).json({
          status: 400,
          message: "No fields to update",
        });
      }

      // Add updated_at
      updates.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `
        UPDATE property_inquiries 
        SET ${updates.join(", ")}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await client.query(query, values);

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Inquiry not found",
        });
      }

      await client.query("COMMIT");

      res.status(200).json({
        status: 200,
        message: "Inquiry updated successfully",
        data: result.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Inquiry update error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to update inquiry",
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

/**
 * PATCH /api/inquiries/:id/status
 * Quick update of inquiry status
 * Accessible by: Admin, Manager, Staff
 */
router.patch(
  "/:id/status",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin", "Manager", "Staff"]),
  async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const { status } = req.body;

    try {
      if (!status) {
        return res.status(400).json({
          status: 400,
          message: "Status is required",
        });
      }

      // Validate status
      const validStatuses = [
        "pending",
        "contacted",
        "scheduled",
        "completed",
        "rejected",
        "cancelled",
      ];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          status: 400,
          message: "Invalid status value",
        });
      }

      const query = `
        UPDATE property_inquiries 
        SET 
          inquiry_status = $1,
          contacted_at = CASE 
            WHEN $1 = 'contacted' AND contacted_at IS NULL 
            THEN CURRENT_TIMESTAMP 
            ELSE contacted_at 
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `;

      const result = await client.query(query, [status, id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Inquiry not found",
        });
      }

      res.status(200).json({
        status: 200,
        message: "Status updated successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Status update error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to update status",
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

/**
 * DELETE /api/inquiries/:id
 * Delete an inquiry
 * Accessible by: Admin, Super Admin
 */
router.delete(
  "/:id",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin"]),
  async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;

    try {
      const query = "DELETE FROM property_inquiries WHERE id = $1 RETURNING *";
      const result = await client.query(query, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Inquiry not found",
        });
      }

      res.status(200).json({
        status: 200,
        message: "Inquiry deleted successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Inquiry deletion error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to delete inquiry",
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /api/inquiries/stats/summary
 * Get inquiry statistics summary
 * Accessible by: Admin, Manager, Staff
 */
router.get(
  "/stats/summary",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin", "Manager", "Staff"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const query = `
        SELECT 
          COUNT(*) as total_inquiries,
          COUNT(CASE WHEN inquiry_status = 'pending' THEN 1 END) as pending,
          COUNT(CASE WHEN inquiry_status = 'contacted' THEN 1 END) as contacted,
          COUNT(CASE WHEN inquiry_status = 'scheduled' THEN 1 END) as scheduled,
          COUNT(CASE WHEN inquiry_status = 'completed' THEN 1 END) as completed,
          COUNT(CASE WHEN inquiry_status = 'rejected' THEN 1 END) as rejected,
          COUNT(CASE WHEN inquiry_status = 'cancelled' THEN 1 END) as cancelled,
          COUNT(CASE WHEN assigned_to IS NULL THEN 1 END) as unassigned,
          COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as last_7_days,
          COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as last_30_days,
          AVG(EXTRACT(EPOCH FROM (contacted_at - created_at)) / 3600)::numeric(10,2) as avg_response_time_hours
        FROM property_inquiries
        WHERE created_at >= CURRENT_DATE - INTERVAL '90 days'
      `;

      const result = await client.query(query);

      res.status(200).json({
        status: 200,
        message: "Statistics retrieved successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Statistics fetch error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch statistics",
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /api/inquiries/property/:propertyId
 * Get all inquiries for a specific property
 * Accessible by: Admin, Manager, Staff
 */
router.get(
  "/property/:propertyId",
  authenticateTokenSimple,
  authorizeRole(["Super Admin", "Admin", "Manager", "Staff"]),
  async (req, res) => {
    const client = await pool.connect();
    const { propertyId } = req.params;

    try {
      const query = `
        SELECT 
          pi.*,
          p.property_name,
          u.unit_number,
          CONCAT(usr.first_name, ' ', usr.last_name) as assigned_to_name
        FROM property_inquiries pi
        JOIN properties p ON pi.property_id = p.id
        LEFT JOIN units u ON pi.unit_id = u.id
        LEFT JOIN users usr ON pi.assigned_to = usr.id
        WHERE pi.property_id = $1
        ORDER BY pi.created_at DESC
      `;

      const result = await client.query(query, [propertyId]);

      res.status(200).json({
        status: 200,
        message: "Property inquiries retrieved successfully",
        data: result.rows,
      });
    } catch (error) {
      console.error("Property inquiries fetch error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch property inquiries",
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

// In your users routes file (e.g., userRoutes.js)
router.get('/users/staff', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          u.id, 
          u.first_name, 
          u.last_name, 
          ur.role_name
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        WHERE u.is_active = true
          AND ur.role_name IN ('Super Admin', 'Admin', 'Manager', 'Staff')
        ORDER BY u.first_name, u.last_name
      `);
      
      res.status(200).json({
        status: 200,
        data: result.rows
      });
    } catch (error) {
      res.status(500).json({
        status: 500,
        message: "Failed to fetch staff users"
      });
    } finally {
      client.release();
    }
  });

export default router;