import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/vacancies
 * Get all properties with vacant units
 * Accessible by: All authenticated users
 */
router.get("/", async (req, res) => {
  const client = await pool.connect();

  try {
    // Get all properties with their vacant units
    const query = `
      WITH property_amenities_agg AS (
        SELECT 
          pa.property_id,
          array_agg(a.name ORDER BY a.name) as amenities
        FROM property_amenities pa
        JOIN amenities a ON pa.amenity_id = a.id
        WHERE a.is_active = true
        GROUP BY pa.property_id
      ),
      vacant_units_agg AS (
        SELECT 
          u.property_id,
          json_agg(
            json_build_object(
              'id', u.id,
              'unit_number', u.unit_number,
              'bedrooms', u.bedrooms,
              'bathrooms', u.bathrooms,
              'size_sq_ft', u.size_sq_ft,
              'floor_number', u.floor_number,
              'monthly_rent', u.monthly_rent,
              'security_deposit', u.security_deposit,
              'occupancy_status', u.occupancy_status
            ) ORDER BY u.unit_number
          ) as vacant_units
        FROM units u
        WHERE u.occupancy_status = 'vacant' 
          AND u.is_active = true
        GROUP BY u.property_id
      )
      SELECT 
        p.id,
        p.property_name as "propertyName",
        p.address,
        p.property_type as type,
        p.total_units as "totalUnits",
        p.size_sq_ft as "squareFootage",
        p.year_built as "yearBuilt",
        p.description,
        p.created_at,
        p.updated_at,
        COALESCE(pa.amenities, ARRAY[]::varchar[]) as amenities,
        COALESCE(vu.vacant_units, '[]'::json) as "vacantUnits"
      FROM properties p
      LEFT JOIN property_amenities_agg pa ON p.id = pa.property_id
      LEFT JOIN vacant_units_agg vu ON p.id = vu.property_id
      WHERE p.is_active = true
        AND EXISTS (
          SELECT 1 FROM units u 
          WHERE u.property_id = p.id 
            AND u.occupancy_status = 'vacant'
            AND u.is_active = true
        )
      ORDER BY p.created_at DESC
    `;

    const result = await client.query(query);

    // Transform the data to ensure vacant_units is always an array
    const properties = result.rows.map(property => ({
      ...property,
      vacantUnits: typeof property.vacantUnits === 'string' 
        ? JSON.parse(property.vacantUnits) 
        : property.vacantUnits
    }));

    res.status(200).json({
      status: 200,
      message: "Vacant properties retrieved successfully",
      data: properties,
      summary: {
        totalProperties: properties.length,
        totalVacantUnits: properties.reduce(
          (sum, p) => sum + p.vacantUnits.length, 
          0
        )
      }
    });
  } catch (error) {
    console.error("Vacant properties fetch error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch vacant properties",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/vacancies/:propertyId
 * Get detailed information about a specific property and its vacant units
 * Accessible by: All authenticated users
 */
router.get("/:propertyId",  async (req, res) => {
  const client = await pool.connect();
  const { propertyId } = req.params;

  try {
    // Get property details
    const propertyQuery = `
      WITH property_amenities_agg AS (
        SELECT 
          pa.property_id,
          array_agg(a.name ORDER BY a.name) as amenities
        FROM property_amenities pa
        JOIN amenities a ON pa.amenity_id = a.id
        WHERE a.is_active = true AND pa.property_id = $1
        GROUP BY pa.property_id
      ),
      vacant_units_details AS (
        SELECT 
          u.property_id,
          json_agg(
            json_build_object(
              'id', u.id,
              'unit_number', u.unit_number,
              'bedrooms', u.bedrooms,
              'bathrooms', u.bathrooms,
              'size_sq_ft', u.size_sq_ft,
              'floor_number', u.floor_number,
              'monthly_rent', u.monthly_rent,
              'security_deposit', u.security_deposit,
              'occupancy_status', u.occupancy_status,
              'created_at', u.created_at,
              'updated_at', u.updated_at
            ) ORDER BY u.unit_number
          ) as vacant_units
        FROM units u
        WHERE u.occupancy_status = 'vacant' 
          AND u.is_active = true
          AND u.property_id = $1
        GROUP BY u.property_id
      )
      SELECT 
        p.id,
        p.property_name as "propertyName",
        p.address,
        p.property_type as type,
        p.total_units as "totalUnits",
        p.size_sq_ft as "squareFootage",
        p.year_built as "yearBuilt",
        p.monthly_rent as "monthlyRent",
        p.security_deposit as "securityDeposit",
        p.description,
        p.latitude,
        p.longitude,
        p.created_at,
        p.updated_at,
        COALESCE(pa.amenities, ARRAY[]::varchar[]) as amenities,
        COALESCE(vu.vacant_units, '[]'::json) as "vacantUnits"
      FROM properties p
      LEFT JOIN property_amenities_agg pa ON p.id = pa.property_id
      LEFT JOIN vacant_units_details vu ON p.id = vu.property_id
      WHERE p.id = $1 AND p.is_active = true
    `;

    const propertyResult = await client.query(propertyQuery, [propertyId]);

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "Property not found or no vacant units available"
      });
    }

    const property = {
      ...propertyResult.rows[0],
      vacantUnits: typeof propertyResult.rows[0].vacantUnits === 'string'
        ? JSON.parse(propertyResult.rows[0].vacantUnits)
        : propertyResult.rows[0].vacantUnits
    };

    res.status(200).json({
      status: 200,
      message: "Property details retrieved successfully",
      data: property
    });
  } catch (error) {
    console.error("Property details fetch error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch property details",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * POST /api/vacancies/inquire
 * Submit an inquiry for a property or specific unit
 * Accessible by: All authenticated users
 */
router.post("/inquire", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      name,
      email,
      phone,
      message,
      preferredContactMethod,
      moveInDate,
      propertyId,
      unitId
    } = req.body;

    // Validate required fields
    if (!name || !email || !phone || !message || !propertyId) {
      return res.status(400).json({
        status: 400,
        message: "Name, email, phone, message, and property ID are required"
      });
    }

    // Verify property exists and has vacant units
    const propertyCheck = await client.query(
      `SELECT p.id, p.property_name 
       FROM properties p
       WHERE p.id = $1 AND p.is_active = true
       AND EXISTS (
         SELECT 1 FROM units u 
         WHERE u.property_id = p.id 
           AND u.occupancy_status = 'vacant'
           AND u.is_active = true
       )`,
      [propertyId]
    );

    if (propertyCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: 404,
        message: "Property not found or no vacant units available"
      });
    }

    // If unitId provided, verify it's vacant
    if (unitId) {
      const unitCheck = await client.query(
        `SELECT id FROM units 
         WHERE id = $1 
           AND property_id = $2 
           AND occupancy_status = 'vacant'
           AND is_active = true`,
        [unitId, propertyId]
      );

      if (unitCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: 404,
          message: "Unit not found or not available"
        });
      }
    }

    // Insert inquiry into database (assuming you have an inquiries table)
    const insertQuery = `
      INSERT INTO property_inquiries (
        property_id,
        unit_id,
        inquirer_name,
        inquirer_email,
        inquirer_phone,
        message,
        preferred_contact_method,
        preferred_move_in_date,
        inquiry_status,
        submitted_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, created_at
    `;

    const inquiryResult = await client.query(insertQuery, [
      propertyId,
      unitId || null,
      name,
      email,
      phone,
      message,
      preferredContactMethod || 'email',
      moveInDate || null,
      'pending',
      req.user?.id || 1
    ]);

    await client.query("COMMIT");

    // TODO: Send email notification to property manager
    // You can implement email notification here

    res.status(201).json({
      status: 201,
      message: "Inquiry submitted successfully",
      data: {
        inquiryId: inquiryResult.rows[0].id,
        submittedAt: inquiryResult.rows[0].created_at
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Inquiry submission error:", error);
    
    // Handle unique constraint violation (duplicate inquiry)
    if (error.code === '23505') {
      return res.status(409).json({
        status: 409,
        message: "You have already submitted an inquiry for this property"
      });
    }

    res.status(500).json({
      status: 500,
      message: "Failed to submit inquiry",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/vacancies/search
 * Search and filter vacant properties
 * Accessible by: All authenticated users
 */
router.get("/search", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      propertyType,
      minRent,
      maxRent,
      bedrooms,
      bathrooms,
      minSize,
      maxSize,
      searchTerm
    } = req.query;

    let whereConditions = ["p.is_active = true"];
    let params = [];
    let paramIndex = 1;

    // Build dynamic WHERE clause
    if (propertyType) {
      whereConditions.push(`p.property_type = $${paramIndex}`);
      params.push(propertyType);
      paramIndex++;
    }

    if (searchTerm) {
      whereConditions.push(
        `(p.property_name ILIKE $${paramIndex} OR p.address ILIKE $${paramIndex})`
      );
      params.push(`%${searchTerm}%`);
      paramIndex++;
    }

    const query = `
      WITH property_amenities_agg AS (
        SELECT 
          pa.property_id,
          array_agg(a.name ORDER BY a.name) as amenities
        FROM property_amenities pa
        JOIN amenities a ON pa.amenity_id = a.id
        WHERE a.is_active = true
        GROUP BY pa.property_id
      ),
      vacant_units_filtered AS (
        SELECT 
          u.property_id,
          json_agg(
            json_build_object(
              'id', u.id,
              'unit_number', u.unit_number,
              'bedrooms', u.bedrooms,
              'bathrooms', u.bathrooms,
              'size_sq_ft', u.size_sq_ft,
              'monthly_rent', u.monthly_rent,
              'security_deposit', u.security_deposit
            ) ORDER BY u.unit_number
          ) as vacant_units
        FROM units u
        WHERE u.occupancy_status = 'vacant' 
          AND u.is_active = true
          ${minRent ? `AND u.monthly_rent >= ${parseFloat(minRent)}` : ''}
          ${maxRent ? `AND u.monthly_rent <= ${parseFloat(maxRent)}` : ''}
          ${bedrooms ? `AND u.bedrooms >= ${parseInt(bedrooms)}` : ''}
          ${bathrooms ? `AND u.bathrooms >= ${parseFloat(bathrooms)}` : ''}
          ${minSize ? `AND u.size_sq_ft >= ${parseInt(minSize)}` : ''}
          ${maxSize ? `AND u.size_sq_ft <= ${parseInt(maxSize)}` : ''}
        GROUP BY u.property_id
      )
      SELECT 
        p.id,
        p.property_name as "propertyName",
        p.address,
        p.property_type as type,
        p.description,
        COALESCE(pa.amenities, ARRAY[]::varchar[]) as amenities,
        COALESCE(vu.vacant_units, '[]'::json) as "vacantUnits"
      FROM properties p
      LEFT JOIN property_amenities_agg pa ON p.id = pa.property_id
      LEFT JOIN vacant_units_filtered vu ON p.id = vu.property_id
      WHERE ${whereConditions.join(' AND ')}
        AND vu.vacant_units IS NOT NULL
        AND vu.vacant_units::text != '[]'
      ORDER BY p.created_at DESC
    `;

    const result = await client.query(query, params);

    const properties = result.rows.map(property => ({
      ...property,
      vacantUnits: typeof property.vacantUnits === 'string'
        ? JSON.parse(property.vacantUnits)
        : property.vacantUnits
    }));

    res.status(200).json({
      status: 200,
      message: "Search results retrieved successfully",
      data: properties,
      summary: {
        totalResults: properties.length,
        totalVacantUnits: properties.reduce(
          (sum, p) => sum + p.vacantUnits.length,
          0
        )
      }
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to search properties",
      error: error.message
    });
  } finally {
    client.release();
  }
});

export default router;