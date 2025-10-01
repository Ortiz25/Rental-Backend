import express from "express";
import pool from "../config/database.js";
import { authenticateTokenSimple } from "../middleware/auth.js";

const router = express.Router();

// Get utility charges with filters
router.get("/", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const allowedRoles = ["Super Admin", "Admin", "Manager", "Staff"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 403,
        message: "Access denied",
        data: null,
      });
    }

    const {
      status = "all",
      search = "",
      month = new Date().getMonth() + 1,
      year = new Date().getFullYear(),
      page = 1,
      limit = 10,
    } = req.query;

    const offset = (page - 1) * limit;

    let whereConditions = [
      "EXTRACT(MONTH FROM uc.billing_month) = $1",
      "EXTRACT(YEAR FROM uc.billing_month) = $2",
    ];
    let queryParams = [month, year];
    let paramCount = 2;

    if (status !== "all") {
      paramCount++;
      whereConditions.push(`uc.charge_status = $${paramCount}`);
      queryParams.push(status);
    }

    if (search) {
      paramCount++;
      whereConditions.push(`(
        t.first_name ILIKE $${paramCount} OR 
        t.last_name ILIKE $${paramCount} OR 
        p.property_name ILIKE $${paramCount} OR
        l.lease_number ILIKE $${paramCount}
      )`);
      queryParams.push(`%${search}%`);
    }

    const whereClause = whereConditions.join(" AND ");

    const query = `
      SELECT 
        uc.*,
        l.lease_number,
        t.first_name || ' ' || t.last_name as tenant_name,
        t.email as tenant_email,
        t.phone as tenant_phone,
        p.property_name,
        u.unit_number,
        p.property_name || ' - Unit ' || u.unit_number as property_unit
      FROM utility_charges uc
      JOIN leases l ON uc.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL AND lt.is_primary_tenant = true
      JOIN tenants t ON lt.tenant_id = t.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE ${whereClause}
      ORDER BY 
        CASE uc.charge_status 
          WHEN 'overdue' THEN 1 
          WHEN 'pending' THEN 2 
          WHEN 'billed' THEN 3
          WHEN 'paid' THEN 4 
          ELSE 5
        END,
        uc.billing_month DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

    queryParams.push(limit, offset);

    const countQuery = `
      SELECT COUNT(*) as total
      FROM utility_charges uc
      JOIN leases l ON uc.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      JOIN tenants t ON lt.tenant_id = t.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE ${whereClause}
    `;

    const [result, countResult] = await Promise.all([
      client.query(query, queryParams),
      client.query(countQuery, queryParams.slice(0, -2)),
    ]);

    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / limit);

    res.status(200).json({
      status: 200,
      message: "Utility charges retrieved successfully",
      data: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching utility charges:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch utility charges",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get utility charges summary
router.get("/summary", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      month = new Date().getMonth() + 1,
      year = new Date().getFullYear(),
    } = req.query;

    const query = `
      SELECT 
        COUNT(*) as total_charges,
        COALESCE(SUM(total_utility_charges), 0) as total_amount,
        COALESCE(SUM(CASE WHEN charge_status = 'paid' THEN total_utility_charges ELSE 0 END), 0) as total_collected,
        COALESCE(SUM(CASE WHEN charge_status IN ('pending', 'billed') THEN total_utility_charges ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN charge_status = 'overdue' THEN total_utility_charges ELSE 0 END), 0) as total_overdue,
        COUNT(CASE WHEN charge_status = 'paid' THEN 1 END) as paid_count,
        COUNT(CASE WHEN charge_status IN ('pending', 'billed') THEN 1 END) as pending_count,
        COUNT(CASE WHEN charge_status = 'overdue' THEN 1 END) as overdue_count
      FROM utility_charges
      WHERE EXTRACT(MONTH FROM billing_month) = $1
      AND EXTRACT(YEAR FROM billing_month) = $2
    `;

    const result = await client.query(query, [month, year]);

    res.status(200).json({
      status: 200,
      message: "Summary retrieved successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error fetching summary:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch summary",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Create utility charge
router.post("/", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const allowedRoles = ["Super Admin", "Admin", "Manager"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 403,
        message: "Access denied",
        data: null,
      });
    }

    const {
      lease_id,
      billing_month,
      water_charges = 0,
      water_usage,
      electricity_charges = 0,
      electricity_usage,
      gas_charges = 0,
      service_charges = 0,
      garbage_charges = 0,
      common_area_charges = 0,
      other_charges = 0,
      other_charges_description,
      due_date,
      charge_status = "pending", // ADD THIS LINE
      notes,
    } = req.body;
    if (!lease_id || !billing_month) {
      return res.status(400).json({
        status: 400,
        message: "Lease ID and billing month are required",
        data: null,
      });
    }

    await client.query("BEGIN");

    const query = `
  INSERT INTO utility_charges (
    lease_id, billing_month, water_charges, water_usage,
    electricity_charges, electricity_usage, gas_charges,
    service_charges, garbage_charges, common_area_charges,
    other_charges, other_charges_description, due_date,
    notes, charge_status, created_by
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  RETURNING *
`;

    const result = await client.query(query, [
      lease_id,
      billing_month,
      water_charges,
      water_usage,
      electricity_charges,
      electricity_usage,
      gas_charges,
      service_charges,
      garbage_charges,
      common_area_charges,
      other_charges,
      other_charges_description,
      due_date,
      notes,
      charge_status,
      req.user.username, // charge_status now comes from request
    ]);

    await client.query("COMMIT");

    res.status(201).json({
      status: 201,
      message: "Utility charge created successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating utility charge:", error);

    if (error.constraint === "unique_lease_billing_month") {
      return res.status(400).json({
        status: 400,
        message: "Utility charge already exists for this lease and month",
        data: null,
      });
    }

    res.status(500).json({
      status: 500,
      message: "Failed to create utility charge",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Update utility charge
router.put("/:id", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const allowedRoles = ["Super Admin", "Admin", "Manager"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 403,
        message: "Access denied",
        data: null,
      });
    }

    const { id } = req.params;
    const updates = req.body;

    await client.query("BEGIN");

    const setClause = Object.keys(updates)
      .map((key, index) => `${key} = $${index + 2}`)
      .join(", ");

    const query = `
      UPDATE utility_charges 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const values = [id, ...Object.values(updates)];
    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Utility charge not found",
        data: null,
      });
    }

    await client.query("COMMIT");

    res.status(200).json({
      status: 200,
      message: "Utility charge updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating utility charge:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to update utility charge",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Delete utility charge
router.delete("/:id", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const allowedRoles = ["Super Admin", "Admin"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 403,
        message: "Access denied",
        data: null,
      });
    }

    const { id } = req.params;

    await client.query("BEGIN");

    const result = await client.query(
      "DELETE FROM utility_charges WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Utility charge not found",
        data: null,
      });
    }

    await client.query("COMMIT");

    res.status(200).json({
      status: 200,
      message: "Utility charge deleted successfully",
      data: null,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting utility charge:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to delete utility charge",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Bill utilities to rent payments
router.post('/bill-to-rent', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      const allowedRoles = ['Super Admin', 'Admin', 'Manager'];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message: 'Access denied',
          data: null
        });
      }
  
      const { month, year } = req.body;
  
      if (!month || !year) {
        return res.status(400).json({
          status: 400,
          message: 'Month and year are required',
          data: null
        });
      }
  
      await client.query('BEGIN');
  
      const query = `SELECT * FROM bill_utilities_to_rent($1, $2)`;
      const result = await client.query(query, [month, year]);
  
      await client.query('COMMIT');
  
      const billedCount = result.rows.length;
  
      res.status(200).json({
        status: 200,
        message: `Successfully billed ${billedCount} utility charges to rent payments`,
        data: {
          billed_count: billedCount,
          details: result.rows
        }
      });
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error billing utilities to rent:', error);
      res.status(500).json({
        status: 500,
        message: 'Failed to bill utilities to rent',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });

// Bulk generate utility charges for active leases
router.post("/generate", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();

  try {
    const allowedRoles = ["Super Admin", "Admin", "Manager"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 403,
        message: "Access denied",
        data: null,
      });
    }

    const { month, year, default_charges = {} } = req.body;

    if (!month || !year) {
      return res.status(400).json({
        status: 400,
        message: "Month and year are required",
        data: null,
      });
    }

    await client.query("BEGIN");

    const billingMonth = new Date(year, month - 1, 1);

    // Get active leases
    const leasesQuery = `
      SELECT l.id as lease_id
      FROM leases l
      WHERE l.lease_status = 'active'
      AND l.start_date <= $1
      AND (l.end_date IS NULL OR l.end_date >= $1)
      AND NOT EXISTS (
        SELECT 1 FROM utility_charges uc
        WHERE uc.lease_id = l.id
        AND uc.billing_month = $1
      )
    `;

    const leasesResult = await client.query(leasesQuery, [billingMonth]);

    if (leasesResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        status: 400,
        message: "No eligible leases found or charges already exist",
        data: null,
      });
    }

    // Bulk insert
    const values = leasesResult.rows
      .map(
        (lease) =>
          `(${lease.lease_id}, '${billingMonth.toISOString().split("T")[0]}', ${default_charges.water_charges || 0}, ${default_charges.service_charges || 0}, 'draft', '${req.user.username}')`
      )
      .join(",");

    const insertQuery = `
      INSERT INTO utility_charges (lease_id, billing_month, water_charges, service_charges, charge_status, created_by)
      VALUES ${values}
      RETURNING id
    `;

    const result = await client.query(insertQuery);

    await client.query("COMMIT");

    res.status(201).json({
      status: 201,
      message: `Generated ${result.rows.length} utility charges`,
      data: { count: result.rows.length },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error generating utility charges:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to generate utility charges",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

export default router;
