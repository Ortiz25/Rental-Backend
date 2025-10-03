import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";

const router = express.Router();

// Helper function to get month start and end dates
const getMonthDateRange = (month, year) => {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0); // Last day of the month
  return {
    start: startDate.toISOString().split("T")[0],
    end: endDate.toISOString().split("T")[0],
  };
};

// Get rent collection data with enhanced verification info
router.get("/rent-collection", authenticateTokenSimple, async (req, res) => {
  console.log("💰 Fetching rent collection data");

  const client = await pool.connect();

  try {
    const allowedRoles = ["Super Admin", "Admin", "Manager", "Staff"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 403,
        message: "Access denied. Insufficient privileges.",
        data: null,
      });
    }

    const { 
      status = 'all',
      search = '',
      month = new Date().getMonth() + 1,
      year = new Date().getFullYear(),
      page = 1, 
      limit = 10 
    } = req.query;

    const offset = (page - 1) * limit;

    // Get date range for the month
    const dateRange = getMonthDateRange(parseInt(month), parseInt(year));

    // Build dynamic WHERE clause
    let whereConditions = ["rp.due_date >= $1", "rp.due_date <= $2"];
    let queryParams = [dateRange.start, dateRange.end];
    let paramCount = 2;

    if (status !== "all") {
      paramCount++;
      whereConditions.push(`rp.payment_status = $${paramCount}`);
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

    // Enhanced query with grace period calculation
    const paymentsQuery = `
      SELECT 
        rp.id,
        rp.lease_id,
        rp.due_date as original_due_date,
        -- Calculate effective due date with grace period
        (rp.due_date + INTERVAL '1 day' * COALESCE(l.grace_period_days, 5)) as due_date,
        rp.payment_date,
        rp.amount_due,
        rp.amount_paid,
        rp.utilities_charges,
        rp.late_fee,
        rp.payment_status,
        rp.payment_method,
        rp.payment_reference,
        rp.notes,
        rp.processed_by,
        
        -- Lease grace period info
        COALESCE(l.grace_period_days, 5) as grace_period_days,
        
        -- Tenant and property info
        t.first_name || ' ' || t.last_name as tenant_name,
        t.email as tenant_email,
        t.phone as tenant_phone,
        p.property_name,
        u.unit_number,
        p.property_name || ' - Unit ' || u.unit_number as property_unit,
        l.lease_number,
        l.monthly_rent,
        
        -- Generate invoice number
        'INV-' || l.lease_number || '-' || TO_CHAR(rp.due_date, 'YYYY-MM') as invoice_number,
        
        -- Get utility breakdown
        (
          SELECT json_build_object(
            'water_charges', uc.water_charges,
            'electricity_charges', uc.electricity_charges,
            'gas_charges', uc.gas_charges,
            'service_charges', uc.service_charges,
            'garbage_charges', uc.garbage_charges,
            'common_area_charges', uc.common_area_charges,
            'other_charges', uc.other_charges,
            'other_charges_description', uc.other_charges_description,
            'total_utility_charges', uc.total_utility_charges,
            'billing_month', uc.billing_month,
            'charge_status', uc.charge_status
          )
          FROM utility_charges uc
          WHERE uc.lease_id = rp.lease_id
          AND DATE_TRUNC('month', uc.billing_month) = DATE_TRUNC('month', rp.due_date)
          AND uc.charge_status = 'billed'
          LIMIT 1
        ) as utility_breakdown,
        
        -- Check for related payment submissions
        (
          SELECT COUNT(*)
          FROM payment_submissions ps
          WHERE ps.lease_id = rp.lease_id 
          AND ps.verification_status = 'pending'
          AND ps.transaction_date BETWEEN rp.due_date - INTERVAL '5 days' AND rp.due_date + INTERVAL '30 days'
        ) as pending_submissions_count,
        
        -- Get latest payment submission info
        (
          SELECT json_build_object(
            'id', ps.id,
            'amount', ps.amount,
            'payment_method', ps.payment_method,
            'transaction_reference', ps.transaction_reference,
            'submission_date', ps.submission_date,
            'verification_status', ps.verification_status
          )
          FROM payment_submissions ps
          WHERE ps.lease_id = rp.lease_id 
          AND ps.verification_status = 'pending'
          ORDER BY ps.submission_date DESC
          LIMIT 1
        ) as latest_submission,
        
        -- Calculate total amount due including utilities
        (rp.amount_due + COALESCE(rp.utilities_charges, 0) + COALESCE(rp.late_fee, 0)) as total_amount_due,
        
        -- Updated days overdue calculation (using grace period)
        CASE 
          WHEN rp.payment_status = 'overdue' THEN 
            EXTRACT(DAY FROM (CURRENT_DATE - (rp.due_date + INTERVAL '1 day' * COALESCE(l.grace_period_days, 5))))::INTEGER
          ELSE 0
        END as days_overdue,
        
        -- Show if payment is within grace period
        CASE 
          WHEN rp.payment_status = 'pending' AND CURRENT_DATE > rp.due_date AND CURRENT_DATE <= (rp.due_date + INTERVAL '1 day' * COALESCE(l.grace_period_days, 5)) THEN true
          ELSE false
        END as within_grace_period
        
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      JOIN tenants t ON lt.tenant_id = t.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE ${whereClause}
      ORDER BY 
        CASE rp.payment_status 
          WHEN 'overdue' THEN 1 
          WHEN 'pending' THEN 2 
          WHEN 'partial' THEN 3 
          WHEN 'paid' THEN 4 
        END,
        rp.due_date DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;
    
    queryParams.push(limit, offset);

    // Count query for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      JOIN tenants t ON lt.tenant_id = t.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE ${whereClause}
    `;

    const [paymentsResult, countResult] = await Promise.all([
      client.query(paymentsQuery, queryParams),
      client.query(countQuery, queryParams.slice(0, -2)), // Remove limit and offset
    ]);

    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / limit);

    console.log(`✅ Found ${paymentsResult.rows.length} rent payments`);

    // Process results to format dates properly
    const processedResults = paymentsResult.rows.map((row) => ({
      ...row,
      due_date: row.due_date, // This now includes grace period
      original_due_date: row.original_due_date, // Original due date without grace period
      days_overdue: Math.max(0, row.days_overdue), // Ensure non-negative
      within_grace_period: row.within_grace_period,
    }));

    res.status(200).json({
      status: 200,
      message: "Rent payments retrieved successfully",
      data: processedResults,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit),
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching rent payments:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch rent payments",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Get rent collection summary with verification stats
router.get(
  "/rent-collection/summary",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("📊 Fetching rent collection summary");

    const client = await pool.connect();

    try {
      const allowedRoles = ["Super Admin", "Admin", "Manager", "Staff"];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message: "Access denied. Insufficient privileges.",
          data: null,
        });
      }

      const {
        month = new Date().getMonth() + 1,
        year = new Date().getFullYear()
      } = req.query;

      // Get date range for the month
      const dateRange = getMonthDateRange(parseInt(month), parseInt(year));

      // Enhanced summary query with verification data
      const summaryQuery = `
        WITH rent_summary AS (
          SELECT 
            COALESCE(SUM(amount_due + COALESCE(utilities_charges, 0) + COALESCE(late_fee, 0)), 0) as total_due,
            COALESCE(SUM(amount_paid), 0) as total_collected,
            COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN amount_due + COALESCE(utilities_charges, 0) ELSE 0 END), 0) as total_pending,
            COALESCE(SUM(CASE WHEN payment_status = 'overdue' THEN amount_due + COALESCE(utilities_charges, 0) - amount_paid ELSE 0 END), 0) as total_overdue,
            COALESCE(SUM(COALESCE(utilities_charges, 0)), 0) as total_utilities,
            COUNT(*) as total_payments,
            COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) as paid_count,
            COUNT(CASE WHEN payment_status = 'overdue' THEN 1 END) as overdue_count,
            COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) as pending_count
          FROM rent_payments 
          WHERE due_date >= $1 AND due_date <= $2
        ),
        verification_summary AS (
          SELECT 
            COUNT(CASE WHEN verification_status = 'pending' THEN 1 END) as pending_verifications,
            COALESCE(SUM(CASE WHEN verification_status = 'pending' THEN amount ELSE 0 END), 0) as pending_verification_amount,
            COUNT(CASE WHEN verification_status = 'verified' AND verified_date >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as verifications_this_month,
            COALESCE(SUM(CASE WHEN verification_status = 'verified' AND verified_date >= DATE_TRUNC('month', CURRENT_DATE) THEN amount ELSE 0 END), 0) as verified_amount_this_month
          FROM payment_submissions
        )
        SELECT 
          rs.*,
          vs.*,
          CASE 
            WHEN rs.total_due > 0 THEN 
              ROUND((rs.total_collected / rs.total_due) * 100, 2)
            ELSE 0
          END as collection_rate,
          CASE 
            WHEN rs.total_payments > 0 THEN 
              ROUND((rs.paid_count::DECIMAL / rs.total_payments) * 100, 2)
            ELSE 0
          END as payment_completion_rate
        FROM rent_summary rs, verification_summary vs
      `;

      const result = await client.query(summaryQuery, [
        dateRange.start,
        dateRange.end,
      ]);
      const summary = result.rows[0];

      // Additional metrics
      const metricsQuery = `
        SELECT 
          -- Average days to pay
          COALESCE(AVG(
            CASE WHEN payment_date IS NOT NULL AND payment_status = 'paid' 
            THEN (payment_date - due_date)
            ELSE NULL END
          ), 0) as avg_days_to_pay,
          -- Late payment rate
          CASE 
            WHEN COUNT(*) > 0 THEN
              ROUND(
                (COUNT(CASE WHEN payment_status = 'overdue' OR (payment_date > due_date + INTERVAL '5 days') THEN 1 END)::DECIMAL
                / COUNT(*)::DECIMAL) * 100, 2
              )
            ELSE 0
          END as late_payment_rate,
          -- Top payment method
          (
            SELECT payment_method 
            FROM rent_payments 
            WHERE payment_method IS NOT NULL 
            AND due_date >= $1 AND due_date <= $2
            GROUP BY payment_method 
            ORDER BY COUNT(*) DESC 
            LIMIT 1
          ) as most_used_payment_method
        FROM rent_payments 
        WHERE due_date >= $1 AND due_date <= $2
      `;

      const metricsResult = await client.query(metricsQuery, [
        dateRange.start,
        dateRange.end,
      ]);
      const metrics = metricsResult.rows[0];

      const responseData = {
        ...summary,
        ...metrics,
        // Convert to proper numbers
        total_due: parseFloat(summary.total_due) || 0,
        total_collected: parseFloat(summary.total_collected) || 0,
        total_pending: parseFloat(summary.total_pending) || 0,
        total_overdue: parseFloat(summary.total_overdue) || 0,
        total_utilities: parseFloat(summary.total_utilities) || 0,
        pending_verification_amount:
          parseFloat(summary.pending_verification_amount) || 0,
        verified_amount_this_month:
          parseFloat(summary.verified_amount_this_month) || 0,
        avg_days_to_pay: parseFloat(metrics.avg_days_to_pay) || 0,
        collection_rate: parseFloat(summary.collection_rate) || 0,
        payment_completion_rate:
          parseFloat(summary.payment_completion_rate) || 0,
        late_payment_rate: parseFloat(metrics.late_payment_rate) || 0,
        pending_verifications: parseInt(summary.pending_verifications) || 0,
        verifications_this_month:
          parseInt(summary.verifications_this_month) || 0,
      };

      res.status(200).json({
        status: 200,
        message: "Rent collection summary retrieved successfully",
        data: responseData,
      });
    } catch (error) {
      console.error("❌ Error fetching rent collection summary:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch rent collection summary",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Process payment (enhanced to work with verification system)
router.put(
  "/rent-collection/:id/process",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("💳 Processing payment for rent payment ID:", req.params.id);

    const client = await pool.connect();

    try {
      const allowedRoles = ["Super Admin", "Admin", "Manager"];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message:
            "Access denied. Insufficient privileges for payment processing.",
          data: null,
        });
      }

      const paymentId = req.params.id;
      const {
        amount_paid,
        payment_method,
        payment_reference = "",
        payment_date = new Date().toISOString().split("T")[0],
        notes = "",
        processed_by = req.user.username || "Admin",
      } = req.body;

      if (!amount_paid || !payment_method) {
        return res.status(400).json({
          status: 400,
          message: "Payment amount and method are required",
          data: null,
        });
      }

      await client.query("BEGIN");

      // Get current payment details
      const currentQuery = `
        SELECT rp.*, l.lease_number, t.first_name || ' ' || t.last_name as tenant_name
        FROM rent_payments rp
        JOIN leases l ON rp.lease_id = l.id
        JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
        JOIN tenants t ON lt.tenant_id = t.id
        WHERE rp.id = $1
      `;

      const currentResult = await client.query(currentQuery, [paymentId]);

      if (currentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Payment record not found",
          data: null,
        });
      }

      const currentPayment = currentResult.rows[0];
      const newTotalPaid =
        parseFloat(currentPayment.amount_paid) + parseFloat(amount_paid);
      const totalDue =
        parseFloat(currentPayment.amount_due) +
        parseFloat(currentPayment.utilities_charges || 0) +
        parseFloat(currentPayment.late_fee || 0);

      // Determine new status
      let newStatus;
      if (newTotalPaid >= totalDue) {
        newStatus = "paid";
      } else if (newTotalPaid > 0) {
        newStatus = "partial";
      } else {
        newStatus = "pending";
      }

      // Update the payment record
      const updateQuery = `
        UPDATE rent_payments 
        SET 
          amount_paid = $1,
          payment_status = $2,
          payment_method = $3,
          payment_reference = $4,
          payment_date = $5,
          notes = CASE WHEN $6 != '' THEN $6 ELSE notes END,
          processed_by = $7,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $8
        RETURNING *
      `;

      const updateResult = await client.query(updateQuery, [
        newTotalPaid,
        newStatus,
        payment_method,
        payment_reference,
        payment_date,
        notes,
        processed_by,
        paymentId,
      ]);

      await client.query("COMMIT");

      console.log(
        `✅ Payment processed successfully for ${currentPayment.tenant_name}`
      );

      res.status(200).json({
        status: 200,
        message: "Payment processed successfully",
        data: {
          ...updateResult.rows[0],
          tenant_name: currentPayment.tenant_name,
          lease_number: currentPayment.lease_number,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error processing payment:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to process payment",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Generate monthly rent payments
router.post(
  "/rent-collection/generate",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("🔄 Generating monthly rent payments");

    const client = await pool.connect();

    try {
      const allowedRoles = ["Super Admin", "Admin", "Manager"];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message: "Access denied. Insufficient privileges.",
          data: null,
        });
      }

      const { month, year } = req.body;

      if (!month || !year || month < 1 || month > 12) {
        return res.status(400).json({
          status: 400,
          message: "Valid month (1-12) and year are required",
          data: null,
        });
      }

      await client.query("BEGIN");

      // Get date range for the month
      const dateRange = getMonthDateRange(parseInt(month), parseInt(year));

      // Check if payments already exist for this month/year
      const existingQuery = `
        SELECT COUNT(*) as count
        FROM rent_payments 
        WHERE due_date >= $1 AND due_date <= $2
      `;

      const existingResult = await client.query(existingQuery, [
        dateRange.start,
        dateRange.end,
      ]);
      const existingCount = parseInt(existingResult.rows[0].count);

      if (existingCount > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: `Rent payments for ${month}/${year} already exist (${existingCount} payments found)`,
          data: null,
        });
      }

      // Get all active leases with their rent due day
      const leasesQuery = `
        SELECT 
          l.id as lease_id,
          l.monthly_rent,
          l.rent_due_day,
          l.late_fee,
          l.grace_period_days,
          t.first_name || ' ' || t.last_name as tenant_name
        FROM leases l
        JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
        JOIN tenants t ON lt.tenant_id = t.id
        WHERE l.lease_status = 'active'
        AND l.start_date <= $1
        AND (l.end_date IS NULL OR l.end_date >= $1)
      `;

      const targetDate = new Date(year, month - 1, 1);
      const leasesResult = await client.query(leasesQuery, [targetDate]);

      if (leasesResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "No active leases found for the specified period",
          data: null,
        });
      }

      // Generate payment records for each lease
      const paymentInserts = [];
      const values = [];
      let paramCount = 0;

      leasesResult.rows.forEach((lease) => {
        const dueDay = lease.rent_due_day || 1;
        const dueDate = new Date(
          year,
          month - 1,
          Math.min(dueDay, new Date(year, month, 0).getDate())
        );

        paramCount += 4;
        paymentInserts.push(
          `($${paramCount - 3}, $${paramCount - 2}, $${paramCount - 1}, $${paramCount})`
        );
        values.push(
          lease.lease_id,
          dueDate.toISOString().split("T")[0],
          lease.monthly_rent,
          lease.late_fee || 0
        );
      });

      const insertQuery = `
        INSERT INTO rent_payments (lease_id, due_date, amount_due, late_fee, amount_paid, payment_status)
        VALUES ${paymentInserts.join(", ")}
        RETURNING id, lease_id
      `;

      const insertResult = await client.query(insertQuery, values);

      await client.query("COMMIT");

      console.log(
        `✅ Generated ${insertResult.rows.length} rent payment records`
      );

      res.status(201).json({
        status: 201,
        message: `Successfully generated ${insertResult.rows.length} rent payment records for ${month}/${year}`,
        data: {
          generated_count: insertResult.rows.length,
          month,
          year,
          payment_ids: insertResult.rows.map((row) => row.id),
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error generating rent payments:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to generate rent payments",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Update overdue payments
router.post(
  "/rent-collection/update-overdue",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("⏰ Updating overdue payment statuses");

    const client = await pool.connect();

    try {
      const allowedRoles = ["Super Admin", "Admin", "Manager"];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message: "Access denied. Insufficient privileges.",
          data: null,
        });
      }

      await client.query("BEGIN");

      // Update payments that are past due and still pending
      const updateQuery = `
        UPDATE rent_payments 
        SET 
          payment_status = 'overdue',
          updated_at = CURRENT_TIMESTAMP
        WHERE payment_status = 'pending' 
        AND due_date < CURRENT_DATE
        RETURNING id, lease_id, due_date, amount_due
      `;

      const updateResult = await client.query(updateQuery);

      await client.query("COMMIT");

      console.log(
        `✅ Updated ${updateResult.rows.length} payments to overdue status`
      );

      res.status(200).json({
        status: 200,
        message: `Successfully updated ${updateResult.rows.length} payments to overdue status`,
        data: {
          updated_count: updateResult.rows.length,
          updated_payments: updateResult.rows,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error updating overdue payments:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to update overdue payments",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

export default router;