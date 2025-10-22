import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";

const router = express.Router();

// Test route without authentication (for debugging)
router.get("/dashboard/test", async (req, res) => {
  console.log("🧪 Test dashboard route accessed");

  try {
    const client = await pool.connect();

    try {
      const result = await client.query(
        "SELECT COUNT(*) as count FROM properties"
      );

      res.status(200).json({
        status: 200,
        message: "Dashboard test successful",
        data: {
          propertyCount: result.rows[0].count,
          timestamp: new Date().toISOString(),
        },
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Test route error:", error);
    res.status(500).json({
      status: 500,
      message: "Database connection failed",
      error: error.message,
    });
  }
});

router.get("/summary", authenticateTokenSimple, async (req, res) => {
  console.log("📊 Dashboard summary route accessed by user:", req.user?.id);

  const client = await pool.connect();

  try {
    // Check if user has appropriate role (but don't block if missing)
    const allowedRoles = ["Super Admin", "Admin", "Manager"];
    if (req.user.role && !allowedRoles.includes(req.user.role)) {
      console.log(
        "⚠️  User role not in preferred list but allowing access:",
        req.user.role
      );
    }

    console.log("Fetching dashboard data...");

    // Property Overview Query
    const propertyQuery = `
        SELECT 
          COUNT(DISTINCT p.id) as total_properties,
          COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END) as occupied_units,
          COUNT(CASE WHEN u.occupancy_status = 'vacant' THEN 1 END) as vacant_units,
          COUNT(CASE WHEN u.occupancy_status = 'maintenance' THEN 1 END) as maintenance_units
        FROM properties p
        LEFT JOIN units u ON p.id = u.property_id
      `;

    // Tenant Management Query
    const tenantQuery = `
        SELECT 
          COUNT(DISTINCT t.id) as active_tenants,
          COUNT(CASE WHEN l.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days' THEN 1 END) as lease_renewals_soon,
          COUNT(CASE WHEN t.created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_applications
        FROM tenants t
        LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
        LEFT JOIN leases l ON lt.lease_id = l.id AND l.lease_status = 'active'
      `;

    // Lease Status Query
    const leaseQuery = `
        SELECT 
          COUNT(CASE WHEN lease_status = 'active' THEN 1 END) as active_leases,
          COUNT(CASE WHEN lease_status = 'active' AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days' THEN 1 END) as expiring_soon,
          COUNT(CASE WHEN lease_status = 'terminated' THEN 1 END) as terminated_leases,
          COUNT(CASE WHEN lease_status = 'expired' THEN 1 END) as expired_leases
        FROM leases
      `;

    // Financial Summary Query (UPDATED - includes utilities tracking)
    const financialQuery = `
       WITH monthly_payments AS (
  SELECT 
    -- Rent collected (excluding utilities)
    COALESCE(SUM(CASE WHEN payment_status = 'paid' 
                      AND payment_date >= DATE_TRUNC('month', CURRENT_DATE) 
                 THEN (amount_paid - COALESCE(utilities_charges, 0)) END), 0) as collected_revenue,
    
    -- Utilities collected separately
    COALESCE(SUM(CASE WHEN payment_status = 'paid' 
                      AND payment_date >= DATE_TRUNC('month', CURRENT_DATE) 
                 THEN COALESCE(utilities_charges, 0) END), 0) as utilities_collected,
    
    -- Total collected (rent + utilities)
    COALESCE(SUM(CASE WHEN payment_status = 'paid' 
                      AND payment_date >= DATE_TRUNC('month', CURRENT_DATE) 
                 THEN amount_paid END), 0) as total_collected,

    -- Outstanding rent (past due only)
    COALESCE(SUM(CASE WHEN payment_status IN ('overdue', 'pending') 
                      AND due_date < CURRENT_DATE 
                 THEN amount_due END), 0) as outstanding_rent
  FROM rent_payments
),
monthly_expected AS (
  -- Use rent_payments records instead of leases for accurate expected revenue
  SELECT 
    COALESCE(SUM(amount_due), 0) as expected_revenue
  FROM rent_payments
  WHERE due_date >= DATE_TRUNC('month', CURRENT_DATE)
    AND due_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
),
monthly_maintenance AS (
  SELECT 
    COALESCE(SUM(CASE WHEN completed_date >= DATE_TRUNC('month', CURRENT_DATE) 
                 THEN actual_cost END), 0) as maintenance_costs
  FROM maintenance_requests
  WHERE actual_cost IS NOT NULL
),
monthly_property_expenses AS (
  SELECT 
    COALESCE(SUM(
      CASE 
        WHEN frequency = 'monthly' AND is_active = true 
          AND start_date <= CURRENT_DATE 
          AND (end_date IS NULL OR end_date >= DATE_TRUNC('month', CURRENT_DATE))
        THEN amount
        
        WHEN frequency = 'quarterly' AND is_active = true
          AND start_date <= CURRENT_DATE
          AND (end_date IS NULL OR end_date >= DATE_TRUNC('month', CURRENT_DATE))
        THEN amount / 3.0
        
        WHEN frequency = 'semi-annual' AND is_active = true
          AND start_date <= CURRENT_DATE
          AND (end_date IS NULL OR end_date >= DATE_TRUNC('month', CURRENT_DATE))
        THEN amount / 6.0
        
        WHEN frequency = 'annual' AND is_active = true
          AND start_date <= CURRENT_DATE
          AND (end_date IS NULL OR end_date >= DATE_TRUNC('month', CURRENT_DATE))
        THEN amount / 12.0
        
        WHEN frequency = 'one-time'
          AND expense_date >= DATE_TRUNC('month', CURRENT_DATE)
          AND expense_date < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')
        THEN amount
        
        ELSE 0
      END
    ), 0) as property_expenses
  FROM property_expenses
  WHERE is_active = true
),
final_metrics AS (
  SELECT 
    mp.collected_revenue,
    mp.utilities_collected,
    mp.total_collected,
    me.expected_revenue,
    mp.outstanding_rent,
    mm.maintenance_costs as maintenance_costs_this_month,
    mpe.property_expenses as property_expenses_this_month,
    
    -- Collection Rate (rent only, excluding utilities)
    CASE 
      WHEN me.expected_revenue > 0 
      THEN ROUND((mp.collected_revenue / me.expected_revenue * 100), 2)
      ELSE 0
    END as collection_rate_percentage,
    
    -- Total Expenses
    mm.maintenance_costs + mpe.property_expenses as total_expenses,
    
    -- Net Operating Income (Rent - Expenses, excluding utilities)
    mp.collected_revenue - (mm.maintenance_costs + mpe.property_expenses) as net_income,
    
    -- Total Cash Flow (Rent + Utilities - Expenses)
    (mp.collected_revenue + mp.utilities_collected) - (mm.maintenance_costs + mpe.property_expenses) as total_cash_flow
  FROM monthly_payments mp
  CROSS JOIN monthly_expected me
  CROSS JOIN monthly_maintenance mm
  CROSS JOIN monthly_property_expenses mpe
)
SELECT * FROM final_metrics;
      `;

    // Maintenance Query
    const maintenanceQuery = `
        SELECT 
          COUNT(CASE WHEN status IN ('open', 'in_progress') THEN 1 END) as open_requests,
          COUNT(CASE WHEN status = 'completed' AND completed_date >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as completed_recently,
          COUNT(CASE WHEN priority = 'emergency' AND status NOT IN ('completed', 'cancelled') THEN 1 END) as urgent_requests
        FROM maintenance_requests
      `;

    // Defaults
    let propertyData = {
      total_properties: 0,
      occupied_units: 0,
      vacant_units: 0,
      maintenance_units: 0,
    };
    let tenantData = {
      active_tenants: 0,
      lease_renewals_soon: 0,
      new_applications: 0,
    };
    let leaseData = {
      active_leases: 0,
      expiring_soon: 0,
      terminated_leases: 0,
      expired_leases: 0,
    };
    let financialData = {
      collected_revenue: 0,
      utilities_collected: 0,
      total_collected: 0,
      expected_revenue: 0,
      outstanding_rent: 0,
      maintenance_costs_this_month: 0,
      property_expenses_this_month: 0,
      collection_rate_percentage: 0,
      total_expenses: 0,
      net_income: 0,
      total_cash_flow: 0,
    };
    let maintenanceData = {
      open_requests: 0,
      completed_recently: 0,
      urgent_requests: 0,
    };

    // Execute queries safely
    try {
      const propertyResult = await client.query(propertyQuery);
      propertyData = propertyResult.rows[0] || propertyData;
      console.log("✅ Property data fetched");
    } catch (error) {
      console.error("❌ Property query failed:", error.message);
    }

    try {
      const tenantResult = await client.query(tenantQuery);
      tenantData = tenantResult.rows[0] || tenantData;
      console.log("✅ Tenant data fetched");
    } catch (error) {
      console.error("❌ Tenant query failed:", error.message);
    }

    try {
      const leaseResult = await client.query(leaseQuery);
      leaseData = leaseResult.rows[0] || leaseData;
      console.log("✅ Lease data fetched");
    } catch (error) {
      console.error("❌ Lease query failed:", error.message);
    }

    try {
      const financialResult = await client.query(financialQuery);
      financialData = financialResult.rows[0] || financialData;
      console.log("✅ Financial data fetched");
    } catch (error) {
      console.error("❌ Financial query failed:", error.message);
    }

    try {
      const maintenanceResult = await client.query(maintenanceQuery);
      maintenanceData = maintenanceResult.rows[0] || maintenanceData;
      console.log("✅ Maintenance data fetched");
    } catch (error) {
      console.error("❌ Maintenance query failed:", error.message);
    }

    // Format the response
    const dashboardData = {
      moduleSummaries: [
        {
          name: "Property Overview",
          icon: "BuildingIcon",
          stats: [
            {
              label: "Total Properties",
              value: parseInt(propertyData.total_properties) || 0,
              color: "bg-blue-100",
            },
            {
              label: "Occupied",
              value: parseInt(propertyData.occupied_units) || 0,
              color: "bg-green-100",
            },
            {
              label: "Vacant",
              value: parseInt(propertyData.vacant_units) || 0,
              color: "bg-red-100",
            },
            {
              label: "Maintenance",
              value: parseInt(propertyData.maintenance_units) || 0,
              color: "bg-yellow-100",
            },
          ],
        },
        {
          name: "Tenant Management",
          icon: "UsersIcon",
          stats: [
            {
              label: "Active Tenants",
              value: parseInt(tenantData.active_tenants) || 0,
              color: "bg-purple-100",
            },
            {
              label: "Lease Renewals",
              value: parseInt(tenantData.lease_renewals_soon) || 0,
              color: "bg-yellow-100",
            },
            {
              label: "New Applications",
              value: parseInt(tenantData.new_applications) || 0,
              color: "bg-indigo-100",
            },
          ],
        },
        {
          name: "Lease Status",
          icon: "FileTextIcon",
          stats: [
            {
              label: "Active Leases",
              value: parseInt(leaseData.active_leases) || 0,
              color: "bg-green-100",
            },
            {
              label: "Expiring Soon",
              value: parseInt(leaseData.expiring_soon) || 0,
              color: "bg-orange-100",
            },
            {
              label: "Terminated",
              value: parseInt(leaseData.terminated_leases) || 0,
              color: "bg-red-100",
            },
            {
              label: "Expired",
              value: parseInt(leaseData.expired_leases) || 0,
              color: "bg-gray-100",
            },
          ],
        },
        {
          name: "Financial Summary",
          icon: "DollarSignIcon",
          stats: [
            {
              label: "Expected Rent Revenue",
              value: `KES ${(parseFloat(financialData.expected_revenue) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-indigo-100",
              sublabel: "Rent due this month",
            },
            {
              label: "Rent Collected",
              value: `KES ${(parseFloat(financialData.collected_revenue) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-green-100",
              sublabel: `${parseFloat(financialData.collection_rate_percentage) || 0}% collected`,
            },
            {
              label: "Utilities Collected",
              value: `KES ${(parseFloat(financialData.utilities_collected) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-cyan-100",
              sublabel: "Utility charges",
            },
            {
              label: "Total Collected",
              value: `KES ${(parseFloat(financialData.total_collected) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-emerald-100",
              sublabel: "Rent + Utilities",
            },
            {
              label: "Outstanding Rent",
              value: `KES ${(parseFloat(financialData.outstanding_rent) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-red-100",
              sublabel: "Past due",
            },
            {
              label: "Maintenance Costs",
              value: `KES ${(parseFloat(financialData.maintenance_costs_this_month) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-yellow-100",
              sublabel: "This month",
            },
            {
              label: "Property Expenses",
              value: `KES ${(parseFloat(financialData.property_expenses_this_month) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-orange-100",
              sublabel: "Operating costs",
            },
            {
              label: "Total Expenses",
              value: `KES ${(parseFloat(financialData.total_expenses) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: "bg-pink-100",
              sublabel: "All costs",
            },
            {
              label: "Net Income",
              value: `KES ${(parseFloat(financialData.net_income) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: parseFloat(financialData.net_income) >= 0 ? "bg-blue-100" : "bg-red-200",
              sublabel: "Rent - Expenses",
            },
            {
              label: "Total Cash Flow",
              value: `KES ${(parseFloat(financialData.total_cash_flow) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              color: parseFloat(financialData.total_cash_flow) >= 0 ? "bg-teal-100" : "bg-red-200",
              sublabel: "All revenue - Expenses",
            },
          ],
        },
        {
          name: "Maintenance",
          icon: "WrenchIcon",
          stats: [
            {
              label: "Open Requests",
              value: parseInt(maintenanceData.open_requests) || 0,
              color: "bg-orange-100",
            },
            {
              label: "Completed This Month",
              value: parseInt(maintenanceData.completed_recently) || 0,
              color: "bg-green-100",
            },
            {
              label: "Urgent",
              value: parseInt(maintenanceData.urgent_requests) || 0,
              color: "bg-red-100",
            },
          ],
        },
      ],
      lastUpdated: new Date().toISOString(),
      userRole: req.user.role,
    };

    console.log("✅ Dashboard data compiled successfully");
    console.log("📊 Financial Summary:", {
      expected: financialData.expected_revenue,
      rentCollected: financialData.collected_revenue,
      utilitiesCollected: financialData.utilities_collected,
      totalCollected: financialData.total_collected,
      collectionRate: financialData.collection_rate_percentage,
      netIncome: financialData.net_income,
      totalCashFlow: financialData.total_cash_flow,
    });

    res.status(200).json({
      status: 200,
      message: "Dashboard data retrieved successfully",
      data: dashboardData,
    });
  } catch (error) {
    console.error("❌ Dashboard data fetch error:", error);

    res.status(500).json({
      status: 500,
      message: "Failed to fetch dashboard data",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
      debug: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});

export default router;
