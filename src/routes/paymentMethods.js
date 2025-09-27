import express from "express";
import pool from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router();


router.get("/properties", authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, property_name, address 
         FROM properties 
         ORDER BY property_name ASC`
      );
      res.json({ success: true, data: result.rows });
    } catch (err) {
      console.error("Error fetching properties:", err.message);
      res.status(500).json({ success: false, error: "Failed to fetch properties" });
    }
  });

/**
 * 📌 Get all payment methods for a property
 */
router.get("/property/:propertyId", authenticateToken, async (req, res) => {
  const { propertyId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM payment_methods WHERE property_id = $1 ORDER BY sort_order ASC, id ASC`,
      [propertyId]
    );

    res.status(200).json({
      status: 200,
      message: "Payment methods fetched successfully",
      data: result.rows,
    });
  } catch (error) {
    console.error("❌ Error fetching payment methods:", error);
    res.status(500).json({ status: 500, message: "Server error", error: error.message });
  }
});

/**
 * 📌 Get single payment method by ID
 */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM payment_methods WHERE id = $1",
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: 404, message: "Payment method not found" });
    }

    res.status(200).json({
      status: 200,
      message: "Payment method retrieved successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Error fetching payment method:", error);
    res.status(500).json({ status: 500, message: "Server error", error: error.message });
  }
});

/**
 * 📌 Create a new payment method
 */
router.post("/", authenticateToken, async (req, res) => {
  const {
    property_id,
    method_code,
    method_name,
    icon,
    is_active,
    sort_order,
    details,
    instructions,
    requires_reference,
    auto_verify,
    processing_time_hours,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO payment_methods 
        (property_id, method_code, method_name, icon, is_active, sort_order, 
         details, instructions, requires_reference, auto_verify, processing_time_hours, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        property_id,
        method_code,
        method_name,
        icon || null,
        is_active ?? true,
        sort_order ?? 0,
        details || {},
        instructions || [],
        requires_reference ?? true,
        auto_verify ?? false,
        processing_time_hours ?? 24,
        req.user?.id || null,
      ]
    );

    res.status(201).json({
      status: 201,
      message: "Payment method created successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Error creating payment method:", error);
    res.status(500).json({ status: 500, message: "Server error", error: error.message });
  }
});

/**
 * 📌 Update a payment method
 */
router.put("/:id", authenticateToken, async (req, res) => {
  const {
    method_code,
    method_name,
    icon,
    is_active,
    sort_order,
    details,
    instructions,
    requires_reference,
    auto_verify,
    processing_time_hours,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE payment_methods
       SET method_code = $1,
           method_name = $2,
           icon = $3,
           is_active = $4,
           sort_order = $5,
           details = $6,
           instructions = $7,
           requires_reference = $8,
           auto_verify = $9,
           processing_time_hours = $10,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING *`,
      [
        method_code,
        method_name,
        icon,
        is_active,
        sort_order,
        details,
        instructions,
        requires_reference,
        auto_verify,
        processing_time_hours,
        req.params.id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: 404, message: "Payment method not found" });
    }

    res.status(200).json({
      status: 200,
      message: "Payment method updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Error updating payment method:", error);
    res.status(500).json({ status: 500, message: "Server error", error: error.message });
  }
});

/**
 * 📌 Delete a payment method
 */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM payment_methods WHERE id = $1 RETURNING id", [
      req.params.id,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ status: 404, message: "Payment method not found" });
    }

    res.status(200).json({
      status: 200,
      message: "Payment method deleted successfully",
      data: { id: result.rows[0].id },
    });
  } catch (error) {
    console.error("❌ Error deleting payment method:", error);
    res.status(500).json({ status: 500, message: "Server error", error: error.message });
  }
});

export default router;
