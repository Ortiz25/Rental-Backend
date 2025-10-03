import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";

const router = express.Router();

// Get pending payment submissions for admin verification
router.get(
  "/payment-submissions/pending",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("🔍 Fetching pending payment submissions for verification");

    const client = await pool.connect();

    try {
      // Check if user has admin privileges
      const allowedRoles = ["Super Admin", "Admin", "Manager"];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message:
            "Access denied. Insufficient privileges for payment verification.",
          data: null,
        });
      }

      const {
        status = "pending",
        search = "",
        payment_method = "all",
        date_from = "",
        date_to = "",
        page = 1,
        limit = 10,
      } = req.query;

      const offset = (page - 1) * limit;

      // Build dynamic WHERE clause
      let whereConditions = ["ps.verification_status = $1"];
      let queryParams = [status];
      let paramCount = 1;

      if (search) {
        paramCount++;
        whereConditions.push(`(
        t.first_name ILIKE $${paramCount} OR 
        t.last_name ILIKE $${paramCount} OR 
        ps.transaction_reference ILIKE $${paramCount} OR
        p.property_name ILIKE $${paramCount}
      )`);
        queryParams.push(`%${search}%`);
      }

      if (payment_method !== "all") {
        paramCount++;
        whereConditions.push(`ps.payment_method = $${paramCount}`);
        queryParams.push(payment_method);
      }

      if (date_from) {
        paramCount++;
        whereConditions.push(`ps.submission_date >= $${paramCount}`);
        queryParams.push(date_from);
      }

      if (date_to) {
        paramCount++;
        whereConditions.push(
          `ps.submission_date <= $${paramCount} + INTERVAL '1 day'`
        );
        queryParams.push(date_to);
      }

      const whereClause = whereConditions.join(" AND ");

      // Main query for pending submissions
      const submissionsQuery = `
      SELECT 
        ps.id,
        ps.tenant_id,
        ps.lease_id,
        ps.amount,
        ps.payment_method,
        ps.transaction_reference,
        ps.transaction_date,
        ps.submission_date,
        ps.verification_status,
        ps.notes as tenant_notes,
        ps.admin_notes,
        t.first_name || ' ' || t.last_name as tenant_name,
        t.email as tenant_email,
        t.phone as tenant_phone,
        p.property_name,
        u.unit_number,
        l.lease_number,
        l.monthly_rent,
        -- Calculate current balance for context
COALESCE((
  SELECT SUM(rp.amount_due + COALESCE(rp.utilities_charges, 0) - rp.amount_paid)
  FROM rent_payments rp
  WHERE rp.lease_id = ps.lease_id 
  AND rp.payment_status IN ('pending', 'overdue')
), 0) as current_balance,
        -- Time since submission for urgency
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ps.submission_date))/3600 as hours_since_submission
      FROM payment_submissions ps
      JOIN tenants t ON ps.tenant_id = t.id
      JOIN leases l ON ps.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE ${whereClause}
      ORDER BY ps.submission_date ASC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;

      queryParams.push(limit, offset);

      // Count query for pagination
      const countQuery = `
      SELECT COUNT(*) as total
      FROM payment_submissions ps
      JOIN tenants t ON ps.tenant_id = t.id
      JOIN leases l ON ps.lease_id = l.id
      WHERE ${whereClause}
    `;

      const [submissionsResult, countResult] = await Promise.all([
        client.query(submissionsQuery, queryParams),
        client.query(countQuery, queryParams.slice(0, -2)), // Remove limit and offset for count
      ]);

      const totalCount = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(totalCount / limit);

      console.log(
        `✅ Found ${submissionsResult.rows.length} pending submissions`
      );

      res.status(200).json({
        status: 200,
        message: "Pending payment submissions retrieved successfully",
        data: submissionsResult.rows,
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
      console.error("❌ Error fetching pending submissions:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch pending payment submissions",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Get payment submission history
router.get(
  "/payment-submissions/history",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("📋 Fetching payment submission history");

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

      const { status = "all", search = "", limit = 20 } = req.query;

      let whereConditions = [];
      let queryParams = [];
      let paramCount = 0;

      if (status !== "all") {
        paramCount++;
        whereConditions.push(`ps.verification_status = $${paramCount}`);
        queryParams.push(status);
      }

      if (search) {
        paramCount++;
        whereConditions.push(`(
        t.first_name ILIKE $${paramCount} OR 
        t.last_name ILIKE $${paramCount} OR 
        ps.transaction_reference ILIKE $${paramCount}
      )`);
        queryParams.push(`%${search}%`);
      }

      const whereClause =
        whereConditions.length > 0
          ? "WHERE " + whereConditions.join(" AND ")
          : "";

      const historyQuery = `
      SELECT 
        ps.id,
        ps.amount,
        ps.payment_method,
        ps.transaction_reference,
        ps.transaction_date,
        ps.submission_date,
        ps.verification_status,
        ps.verified_date,
        ps.notes as tenant_notes,
        ps.admin_notes,
        t.first_name || ' ' || t.last_name as tenant_name,
        p.property_name,
        u.unit_number,
        l.lease_number,
        CASE 
          WHEN ps.verified_by IS NOT NULL THEN 
            (SELECT username FROM users WHERE id = ps.verified_by)
          ELSE NULL 
        END as verified_by_username
      FROM payment_submissions ps
      JOIN tenants t ON ps.tenant_id = t.id
      JOIN leases l ON ps.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      ${whereClause}
      ORDER BY ps.submission_date DESC
      LIMIT $${paramCount + 1}
    `;

      queryParams.push(limit);

      const result = await client.query(historyQuery, queryParams);

      res.status(200).json({
        status: 200,
        message: "Payment submission history retrieved successfully",
        data: result.rows,
      });
    } catch (error) {
      console.error("❌ Error fetching submission history:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch submission history",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Get verification statistics
router.get(
  "/payment-submissions/stats",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("📊 Fetching verification statistics");

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

      const statsQuery = `
      SELECT 
        COUNT(CASE WHEN verification_status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN verification_status = 'verified' AND verified_date >= CURRENT_DATE THEN 1 END) as verified_today,
        COUNT(CASE WHEN verification_status = 'rejected' THEN 1 END) as rejected_count,
        COALESCE(SUM(CASE WHEN verification_status = 'pending' THEN amount END), 0) as total_pending_amount,
        COALESCE(SUM(CASE WHEN verification_status = 'verified' AND verified_date >= CURRENT_DATE THEN amount END), 0) as verified_amount_today,
        -- Average processing time
        COALESCE(AVG(
          CASE WHEN verification_status IN ('verified', 'rejected') AND verified_date IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (verified_date - submission_date))/3600 
          END
        ), 0) as avg_processing_hours,
        -- Oldest pending submission
        MIN(CASE WHEN verification_status = 'pending' THEN submission_date END) as oldest_pending
      FROM payment_submissions
    `;

      const result = await client.query(statsQuery);
      const stats = result.rows[0];

      // Additional stats for recent activity
      const recentActivityQuery = `
      SELECT 
        COUNT(CASE WHEN submission_date >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as submissions_this_week,
        COUNT(CASE WHEN verified_date >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as verifications_this_week
      FROM payment_submissions
    `;

      const recentResult = await client.query(recentActivityQuery);
      const recentStats = recentResult.rows[0];

      const responseData = {
        ...stats,
        ...recentStats,
        pending_count: parseInt(stats.pending_count) || 0,
        verified_today: parseInt(stats.verified_today) || 0,
        rejected_count: parseInt(stats.rejected_count) || 0,
        total_pending_amount: parseFloat(stats.total_pending_amount) || 0,
        verified_amount_today: parseFloat(stats.verified_amount_today) || 0,
        avg_processing_hours: parseFloat(stats.avg_processing_hours) || 0,
        submissions_this_week: parseInt(recentStats.submissions_this_week) || 0,
        verifications_this_week:
          parseInt(recentStats.verifications_this_week) || 0,
      };

      res.status(200).json({
        status: 200,
        message: "Verification statistics retrieved successfully",
        data: responseData,
      });
    } catch (error) {
      console.error("❌ Error fetching verification stats:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch verification statistics",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Get single payment submission details
router.get(
  "/payment-submissions/:id",
  authenticateTokenSimple,
  async (req, res) => {
    console.log(
      "🔍 Fetching payment submission details for ID:",
      req.params.id
    );

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

      const submissionId = req.params.id;

      const detailsQuery = `
      SELECT 
        ps.*,
        t.first_name || ' ' || t.last_name as tenant_name,
        t.email as tenant_email,
        t.phone as tenant_phone,
        p.property_name,
        p.address as property_address,
        u.unit_number,
        l.lease_number,
        l.monthly_rent,
        l.start_date as lease_start,
        l.end_date as lease_end,
        -- Current balance
        COALESCE((
  SELECT SUM(rp.amount_due + COALESCE(rp.utilities_charges, 0) - rp.amount_paid)
  FROM rent_payments rp
  WHERE rp.lease_id = ps.lease_id 
  AND rp.payment_status IN ('pending', 'overdue')
), 0) as current_balance,
        -- Recent payments
        (
          SELECT json_agg(
            json_build_object(
              'id', rp.id,
              'due_date', rp.due_date,
              'amount_due', rp.amount_due,
              'amount_paid', rp.amount_paid,
              'payment_status', rp.payment_status,
              'payment_date', rp.payment_date
            ) ORDER BY rp.due_date DESC
          )
          FROM rent_payments rp
          WHERE rp.lease_id = ps.lease_id
          LIMIT 5
        ) as recent_payments,
        -- Verifier info if verified
        CASE 
          WHEN ps.verified_by IS NOT NULL THEN 
            (SELECT first_name || ' ' || last_name FROM users WHERE id = ps.verified_by)
          ELSE NULL 
        END as verified_by_name
      FROM payment_submissions ps
      JOIN tenants t ON ps.tenant_id = t.id
      JOIN leases l ON ps.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE ps.id = $1
    `;

      const result = await client.query(detailsQuery, [submissionId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Payment submission not found",
          data: null,
        });
      }

      const submission = result.rows[0];

      res.status(200).json({
        status: 200,
        message: "Payment submission details retrieved successfully",
        data: submission,
      });
    } catch (error) {
      console.error("❌ Error fetching submission details:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch submission details",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Verify payment submission

router.put(
  "/payment-submissions/:id/verify",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const submissionId = req.params.id;
      const {
        admin_notes,
        verified_amount,
        apply_to_account = true,
      } = req.body;

      // ✅ IMPROVED: Enhanced validation
      if (!admin_notes?.trim()) {
        return res.status(400).json({
          status: 400,
          message: "Admin notes are required for verification",
          data: null,
        });
      }

      await client.query("BEGIN");

      // ✅ IMPROVED: Get detailed submission info with validation
      const submissionQuery = `
      SELECT 
        ps.*,
        l.lease_number,
        l.lease_status,
        t.first_name || ' ' || t.last_name as tenant_name,
        p.property_name || ' - Unit ' || u.unit_number as property_unit,
        -- Check if tenant is blacklisted
        t.is_blacklisted,
        t.blacklist_severity,
        -- Get pending rent payments count
        (SELECT COUNT(*) FROM rent_payments rp 
         WHERE rp.lease_id = ps.lease_id 
         AND rp.payment_status IN ('pending', 'overdue')) as pending_payments_count,
        -- Get total amount due
        (SELECT COALESCE(SUM(rp.amount_due + COALESCE(rp.utilities_charges, 0) - rp.amount_paid), 0) 
 FROM rent_payments rp 
 WHERE rp.lease_id = ps.lease_id 
 AND rp.payment_status IN ('pending', 'overdue')) as total_amount_due
      FROM payment_submissions ps
      JOIN tenants t ON ps.tenant_id = t.id
      JOIN leases l ON ps.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE ps.id = $1 AND ps.verification_status = 'pending'
    `;

      const submissionResult = await client.query(submissionQuery, [
        submissionId,
      ]);

      if (submissionResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Payment submission not found or already processed",
          data: null,
        });
      }

      const submission = submissionResult.rows[0];

      // ✅ IMPROVED: Pre-verification validations
      if (submission.lease_status !== "active") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: `Cannot verify payment for ${submission.lease_status} lease`,
          data: null,
        });
      }

      if (
        submission.is_blacklisted &&
        submission.blacklist_severity === "severe"
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Cannot verify payment for severely blacklisted tenant",
          data: null,
        });
      }

      if (submission.pending_payments_count === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "No pending payments found for this lease",
          data: null,
        });
      }

      const amountToVerify = verified_amount || submission.amount;

      // ✅ IMPROVED: Amount validation
      if (amountToVerify <= 0 || amountToVerify > submission.amount) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Invalid verified amount",
          data: null,
        });
      }

      // ✅ IMPROVED: Check for duplicate verification attempts
      const duplicateCheck = `
      SELECT COUNT(*) as count
      FROM payment_submissions 
      WHERE tenant_id = $1 
      AND transaction_reference = $2 
      AND verification_status = 'verified'
      AND id != $3
    `;

      const duplicateResult = await client.query(duplicateCheck, [
        submission.tenant_id,
        submission.transaction_reference,
        submissionId,
      ]);

      if (parseInt(duplicateResult.rows[0].count) > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Duplicate transaction reference already verified",
          data: null,
        });
      }

      // ✅ IMPROVED: Update submission with better tracking
      const updateSubmissionQuery = `
      UPDATE payment_submissions 
      SET 
        verification_status = 'verified',
        verified_date = CURRENT_TIMESTAMP,
        verified_by = $1,
        admin_notes = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;

      const updateResult = await client.query(updateSubmissionQuery, [
        req.user.id,
        admin_notes.trim(),
        submissionId,
      ]);

      // ✅ IMPROVED: Enhanced activity logging
      const logQuery = `
      INSERT INTO user_activity_log (
        user_id, 
        activity_type, 
        activity_description,
        affected_resource_type,
        affected_resource_id,
        additional_data
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `;

      await client.query(logQuery, [
        req.user.id,
        "payment_verified",
        `Verified payment submission of $${amountToVerify} from ${submission.tenant_name} (${submission.transaction_reference})`,
        "payment_submission",
        submissionId,
        JSON.stringify({
          tenant_name: submission.tenant_name,
          property_unit: submission.property_unit,
          transaction_reference: submission.transaction_reference,
          amount: amountToVerify,
          lease_number: submission.lease_number,
        }),
      ]);

      await client.query("COMMIT");

      console.log(
        `✅ Payment submission ${submissionId} verified successfully by ${req.user.username}`
      );

      // ✅ IMPROVED: Return comprehensive response
      res.status(200).json({
        status: 200,
        message: "Payment submission verified successfully",
        data: {
          ...updateResult.rows[0],
          verified_amount: amountToVerify,
          tenant_name: submission.tenant_name,
          property_unit: submission.property_unit,
          total_amount_due: submission.total_amount_due,
          pending_payments_count: submission.pending_payments_count,
        },
      });

      // Note: Database trigger automatically handles rent_payments table updates
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error verifying payment submission:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to verify payment submission",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

router.get(
  "/payment-submissions/:id/application-result",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const submissionId = req.params.id;

      // Get the application result after verification
      const resultQuery = `
      SELECT 
        ps.id as submission_id,
        ps.amount as submitted_amount,
        ps.verification_status,
        ps.verified_date,
        -- Find which rent payment was affected
        rp.id as rent_payment_id,
        rp.due_date,
        rp.amount_due,
        rp.amount_paid,
        rp.payment_status,
        rp.payment_date,
        rp.payment_reference,
        -- Calculate remaining balance for the lease
        (SELECT COALESCE(SUM(rp2.amount_due - rp2.amount_paid), 0)
         FROM rent_payments rp2 
         WHERE rp2.lease_id = ps.lease_id 
         AND rp2.payment_status IN ('pending', 'overdue')) as remaining_balance
      FROM payment_submissions ps
      LEFT JOIN rent_payments rp ON (
        rp.lease_id = ps.lease_id 
        AND rp.payment_reference = ps.transaction_reference
        AND rp.payment_date = ps.transaction_date
      )
      WHERE ps.id = $1
    `;

      const result = await client.query(resultQuery, [submissionId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Payment submission not found",
          data: null,
        });
      }

      res.status(200).json({
        status: 200,
        message: "Payment application result retrieved successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("❌ Error fetching application result:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch payment application result",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// ✅ NEW: Manual rent payment application (for edge cases)
router.post(
  "/payment-submissions/:id/manual-apply",
  authenticateTokenSimple,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const allowedRoles = ["Super Admin", "Admin"];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message: "Access denied. Super Admin or Admin role required.",
          data: null,
        });
      }

      const submissionId = req.params.id;
      const { rent_payment_id, apply_amount, notes } = req.body;

      if (!rent_payment_id || !apply_amount || apply_amount <= 0) {
        return res.status(400).json({
          status: 400,
          message: "Valid rent payment ID and amount are required",
          data: null,
        });
      }

      await client.query("BEGIN");

      // Get submission details
      const submissionQuery = `
      SELECT ps.*, l.lease_number
      FROM payment_submissions ps
      JOIN leases l ON ps.lease_id = l.id
      WHERE ps.id = $1 AND ps.verification_status = 'verified'
    `;

      const submissionResult = await client.query(submissionQuery, [
        submissionId,
      ]);

      if (submissionResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Verified payment submission not found",
          data: null,
        });
      }

      const submission = submissionResult.rows[0];

      // Get rent payment details
      const rentPaymentQuery = `
      SELECT * FROM rent_payments 
      WHERE id = $1 AND lease_id = $2
    `;

      const rentPaymentResult = await client.query(rentPaymentQuery, [
        rent_payment_id,
        submission.lease_id,
      ]);

      if (rentPaymentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Rent payment not found for this lease",
          data: null,
        });
      }

      const rentPayment = rentPaymentResult.rows[0];
      const remainingDue = rentPayment.amount_due - rentPayment.amount_paid;

      if (apply_amount > remainingDue) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: `Amount exceeds remaining due ($${remainingDue})`,
          data: null,
        });
      }

      // Apply payment manually
      const newAmountPaid =
        parseFloat(rentPayment.amount_paid) + parseFloat(apply_amount);
      const newStatus =
        newAmountPaid >= rentPayment.amount_due ? "paid" : "partial";

      const updateRentPaymentQuery = `
      UPDATE rent_payments 
      SET 
        amount_paid = $1,
        payment_status = $2,
        payment_method = $3,
        payment_reference = $4,
        payment_date = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `;

      const updateResult = await client.query(updateRentPaymentQuery, [
        newAmountPaid,
        newStatus,
        submission.payment_method,
        submission.transaction_reference,
        submission.transaction_date,
        rent_payment_id,
      ]);

      // Log manual application
      const logQuery = `
      INSERT INTO user_activity_log (
        user_id, 
        activity_type, 
        activity_description,
        affected_resource_type,
        affected_resource_id
      ) VALUES ($1, $2, $3, $4, $5)
    `;

      await client.query(logQuery, [
        req.user.id,
        "manual_payment_application",
        `Manually applied $${apply_amount} from submission ${submissionId} to rent payment ${rent_payment_id}. ${notes || ""}`,
        "rent_payment",
        rent_payment_id,
      ]);

      await client.query("COMMIT");

      res.status(200).json({
        status: 200,
        message: "Payment applied manually to rent payment",
        data: {
          rent_payment: updateResult.rows[0],
          applied_amount: apply_amount,
          new_status: newStatus,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error manually applying payment:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to manually apply payment",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Reject payment submission
router.put("/payment-submissions/:id/reject", authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const allowedRoles = ["Super Admin", "Admin", "Manager"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        status: 403,
        message: "Access denied. Insufficient privileges for payment verification.",
        data: null,
      });
    }

    const submissionId = req.params.id;
    const { admin_notes } = req.body;

    if (!admin_notes || !admin_notes.trim()) {
      return res.status(400).json({
        status: 400,
        message: "Rejection reason is required",
        data: null,
      });
    }

    await client.query("BEGIN");

    // Check if submission exists and is pending
    const checkQuery = `
      SELECT 
        ps.*, 
        t.first_name || ' ' || t.last_name as tenant_name,
        u.id as tenant_user_id
      FROM payment_submissions ps
      JOIN tenants t ON ps.tenant_id = t.id
      LEFT JOIN users u ON u.tenant_id = t.id
      WHERE ps.id = $1 AND ps.verification_status = 'pending'
    `;

    const checkResult = await client.query(checkQuery, [submissionId]);

    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Payment submission not found or already processed",
        data: null,
      });
    }

    const submission = checkResult.rows[0];

    // Update the submission status
    const updateQuery = `
      UPDATE payment_submissions 
      SET 
        verification_status = 'rejected',
        verified_date = CURRENT_TIMESTAMP,
        verified_by = $1,
        admin_notes = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;

    const updateResult = await client.query(updateQuery, [
      req.user.id,
      admin_notes.trim(),
      submissionId,
    ]);

    // ✅ ADD THIS: Create notification for tenant
    if (submission.tenant_user_id) {
      const notificationQuery = `
        INSERT INTO user_notifications (
          user_id,
          notification_type,
          title,
          message,
          related_resource_type,
          related_resource_id,
          is_urgent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;

      await client.query(notificationQuery, [
        submission.tenant_user_id,
        'payment_rejected',
        'Payment Submission Rejected',
        `Your payment submission of ${submission.amount} has been rejected. Reason: ${admin_notes.trim()}. Please contact property management for clarification.`,
        'payment_submission',
        submissionId,
        true
      ]);
    }

    // Log the rejection activity
    const logQuery = `
      INSERT INTO user_activity_log (
        user_id, 
        activity_type, 
        activity_description,
        affected_resource_type,
        affected_resource_id
      ) VALUES ($1, $2, $3, $4, $5)
    `;

    await client.query(logQuery, [
      req.user.id,
      "payment_rejected",
      `Rejected payment submission of $${submission.amount} from ${submission.tenant_name}. Reason: ${admin_notes.trim()}`,
      "payment_submission",
      submissionId,
    ]);

    await client.query("COMMIT");

    console.log(`❌ Payment submission ${submissionId} rejected successfully`);

    res.status(200).json({
      status: 200,
      message: "Payment submission rejected successfully. Tenant has been notified.",
      data: updateResult.rows[0],
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error rejecting payment submission:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to reject payment submission",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});


// Bulk verify payment submissions
router.put(
  "/payment-submissions/bulk-verify",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("🔄 Bulk verifying payment submissions");

    const client = await pool.connect();

    try {
      const allowedRoles = ["Super Admin", "Admin", "Manager"];
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          status: 403,
          message:
            "Access denied. Insufficient privileges for payment verification.",
          data: null,
        });
      }

      const { submission_ids, admin_notes, apply_to_account = true } = req.body;

      if (
        !submission_ids ||
        !Array.isArray(submission_ids) ||
        submission_ids.length === 0
      ) {
        return res.status(400).json({
          status: 400,
          message: "Valid submission IDs array is required",
          data: null,
        });
      }

      if (!admin_notes || !admin_notes.trim()) {
        return res.status(400).json({
          status: 400,
          message: "Admin notes are required for bulk verification",
          data: null,
        });
      }

      await client.query("BEGIN");

      // Verify all submissions are pending and belong to valid tenants
      const checkPlaceholders = submission_ids
        .map((_, index) => `$${index + 1}`)
        .join(",");
      const checkQuery = `
      SELECT ps.id, ps.amount, t.first_name || ' ' || t.last_name as tenant_name
      FROM payment_submissions ps
      JOIN tenants t ON ps.tenant_id = t.id
      WHERE ps.id IN (${checkPlaceholders}) AND ps.verification_status = 'pending'
    `;

      const checkResult = await client.query(checkQuery, submission_ids);

      if (checkResult.rows.length !== submission_ids.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: 400,
          message: "Some submissions not found or already processed",
          data: null,
        });
      }

      // Bulk update all submissions - Fix the parameter indexing
      const updatePlaceholders = submission_ids
        .map((_, index) => `$${index + 3}`) // Start from $3 since $1 and $2 are used for verified_by and admin_notes
        .join(",");

      const updateQuery = `
      UPDATE payment_submissions 
      SET 
        verification_status = 'verified',
        verified_date = CURRENT_TIMESTAMP,
        verified_by = $1,
        admin_notes = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${updatePlaceholders})
      RETURNING id, amount
    `;

      const updateParams = [req.user.id, admin_notes.trim(), ...submission_ids];
      const updateResult = await client.query(updateQuery, updateParams);

      // Log bulk verification activity
      const totalAmount = updateResult.rows.reduce(
        (sum, row) => sum + parseFloat(row.amount),
        0
      );
      const logQuery = `
      INSERT INTO user_activity_log (
        user_id, 
        activity_type, 
        activity_description,
        affected_resource_type,
        affected_resource_id
      ) VALUES ($1, $2, $3, $4, $5)
    `;

      await client.query(logQuery, [
        req.user.id,
        "bulk_payment_verified",
        `Bulk verified ${updateResult.rows.length} payment submissions totaling $${totalAmount.toFixed(2)}`,
        "payment_submission",
        null,
      ]);

      await client.query("COMMIT");

      console.log(
        `✅ Bulk verified ${updateResult.rows.length} payment submissions`
      );

      res.status(200).json({
        status: 200,
        message: `Successfully verified ${updateResult.rows.length} payment submissions`,
        data: {
          verified_count: updateResult.rows.length,
          total_amount: totalAmount,
          submission_ids: updateResult.rows.map((row) => row.id),
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error bulk verifying payment submissions:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to bulk verify payment submissions",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

export default router;
