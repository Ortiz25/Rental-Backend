import express from "express";
import pool from "../config/database.js";
import {
  authenticateToken,
  authorizeRole,
  authenticateTokenSimple,
} from "../middleware/auth.js";

const router = express.Router();

// Financial Summary - Main metrics for dashboard
router.get("/summary", authenticateTokenSimple, async (req, res) => {
  console.log("📊 Financial summary route accessed by user:", req.user?.id);

  const client = await pool.connect();

  try {
    const allowedRoles = ["Super Admin", "Admin", "Manager"];
    if (req.user.role && !allowedRoles.includes(req.user.role)) {
      console.log(
        "⚠️  User role not in preferred list but allowing access:",
        req.user.role
      );
    }

    // Get date range from query params (default to current month)
    const { startDate, endDate, period = "month" } = req.query;

    let dateFilter = "";
    let queryParams = [];

    if (startDate && endDate) {
      dateFilter = `AND payment_date BETWEEN $1 AND $2`;
      queryParams = [startDate, endDate];
    } else if (period === "month") {
      dateFilter = `AND payment_date >= DATE_TRUNC('month', CURRENT_DATE)`;
    } else if (period === "quarter") {
      dateFilter = `AND payment_date >= DATE_TRUNC('quarter', CURRENT_DATE)`;
    } else if (period === "year") {
      dateFilter = `AND payment_date >= DATE_TRUNC('year', CURRENT_DATE)`;
    }

    // Total Revenue Query
    const revenueQuery = `
            SELECT 
                COALESCE(SUM(amount_paid), 0) as total_revenue,
                COALESCE(SUM(CASE WHEN payment_date >= CURRENT_DATE - INTERVAL '30 days' THEN amount_paid END), 0) as revenue_last_30_days,
                COALESCE(SUM(CASE WHEN payment_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') 
                    AND payment_date < DATE_TRUNC('month', CURRENT_DATE) THEN amount_paid END), 0) as revenue_previous_month
            FROM rent_payments
            WHERE payment_status = 'paid' ${dateFilter}
        `;

    // Total Expenses Query (from maintenance costs)
    const expensesQuery = `
    SELECT 
        COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) as total_expenses,
        COALESCE(SUM(CASE WHEN completed_date >= CURRENT_DATE - INTERVAL '30 days' 
            THEN COALESCE(actual_cost, estimated_cost) END), 0) as expenses_last_30_days,
        COALESCE(SUM(CASE WHEN completed_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') 
            AND completed_date < DATE_TRUNC('month', CURRENT_DATE) 
            THEN COALESCE(actual_cost, estimated_cost) END), 0) as expenses_previous_month
    FROM maintenance_requests
    WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
    ${dateFilter.replace("payment_date", "completed_date")}
`;

    // Occupancy Rate Query
    const occupancyQuery = `
            SELECT 
                COUNT(CASE WHEN occupancy_status = 'occupied' THEN 1 END) as occupied_units,
                COUNT(*) as total_units,
                CASE 
                    WHEN COUNT(*) > 0 THEN 
                        ROUND((COUNT(CASE WHEN occupancy_status = 'occupied' THEN 1 END)::DECIMAL / COUNT(*)) * 100, 2)
                    ELSE 0
                END as occupancy_rate
            FROM units
        `;

    // Pending Payments Query
    const pendingQuery = `
            SELECT 
                COALESCE(SUM(amount_due - amount_paid), 0) as pending_payments
            FROM rent_payments
            WHERE payment_status IN ('pending', 'overdue', 'partial')
        `;

    // Maintenance Costs Query
    const maintenanceQuery = `
    SELECT 
        COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) as maintenance_costs
    FROM maintenance_requests
    WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
    AND (completed_date >= DATE_TRUNC('month', CURRENT_DATE) 
         OR (completed_date IS NULL AND requested_date >= DATE_TRUNC('month', CURRENT_DATE)))
`;

    const propertyExpensesQuery = `
    SELECT 
        COALESCE(SUM(
            CASE 
                WHEN frequency = 'monthly' THEN amount
                WHEN frequency = 'quarterly' THEN amount / 3
                WHEN frequency = 'annual' THEN amount / 12
                WHEN frequency = 'one-time' AND start_date BETWEEN DATE_TRUNC('month', CURRENT_DATE) AND CURRENT_DATE THEN amount
                ELSE 0
            END
        ), 0) as property_expenses
    FROM property_expenses
    WHERE is_active = true
    AND (end_date IS NULL OR end_date >= CURRENT_DATE)
    AND start_date <= CURRENT_DATE
`;

    // Execute all queries with proper parameter handling
    const expenseParams = queryParams.length > 0 ? queryParams : [];
    const maintenanceExpenseQuery = expensesQuery
      .replace("$1", queryParams.length > 0 ? "$1" : "NULL")
      .replace("$2", queryParams.length > 0 ? "$2" : "NULL");

    const [
      revenueResult,
      expensesResult,
      occupancyResult,
      pendingResult,
      maintenanceResult,
      propertyExpensesResult, // Add this
    ] = await Promise.all([
      client.query(revenueQuery, queryParams),
      client.query(expensesQuery, expenseParams),
      client.query(occupancyQuery),
      client.query(pendingQuery),
      client.query(maintenanceQuery),
      client.query(propertyExpensesQuery), // Add this
    ]);

    const maintenanceExpenses =
      parseFloat(expensesResult.rows[0].total_expenses) || 0;
    const propertyExpenses =
      parseFloat(propertyExpensesResult.rows[0].property_expenses) || 0;
    const totalExpenses = maintenanceExpenses + propertyExpenses;

    const revenue = parseFloat(revenueResult.rows[0].total_revenue) || 0;
    const expenses = parseFloat(expensesResult.rows[0].total_expenses) || 0;
    const revenueLastMonth =
      parseFloat(revenueResult.rows[0].revenue_previous_month) || 0;
    const expensesLastMonth =
      parseFloat(expensesResult.rows[0].expenses_previous_month) || 0;

    // Calculate percentage changes
    const revenueChange =
      revenueLastMonth > 0
        ? (((revenue - revenueLastMonth) / revenueLastMonth) * 100).toFixed(1)
        : 0;
    const expenseChange =
      expensesLastMonth > 0
        ? (((expenses - expensesLastMonth) / expensesLastMonth) * 100).toFixed(
            1
          )
        : 0;

    const summary = {
      totalRevenue: revenue,
      totalExpenses: totalExpenses,
      netIncome: revenue - totalExpenses,
      occupancyRate: parseFloat(occupancyResult.rows[0].occupancy_rate) || 0,
      pendingPayments: parseFloat(pendingResult.rows[0].pending_payments) || 0,
      maintenanceCosts:
        parseFloat(maintenanceResult.rows[0].maintenance_costs) || 0,
      changes: {
        revenue: parseFloat(revenueChange),
        expenses: parseFloat(expenseChange),
        netIncome: parseFloat(revenueChange) - parseFloat(expenseChange),
      },
    };

    res.status(200).json({
      status: 200,
      message: "Financial summary retrieved successfully",
      data: { summary },
    });
  } catch (error) {
    console.error("❌ Financial summary error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch financial summary",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

router.get(
  "/maintenance-summary",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("🔧 Maintenance summary route accessed");

    const client = await pool.connect();

    try {
      const { period = "month", propertyId } = req.query;

      let dateFilter = "";
      let propertyFilter = "";
      const params = [];
      let paramCount = 1;

      if (period === "month") {
        dateFilter = `AND COALESCE(completed_date, requested_date) >= DATE_TRUNC('month', CURRENT_DATE)`;
      } else if (period === "quarter") {
        dateFilter = `AND COALESCE(completed_date, requested_date) >= DATE_TRUNC('quarter', CURRENT_DATE)`;
      } else if (period === "year") {
        dateFilter = `AND COALESCE(completed_date, requested_date) >= DATE_TRUNC('year', CURRENT_DATE)`;
      }

      if (propertyId) {
        propertyFilter = `AND u.property_id = $${paramCount}`;
        params.push(propertyId);
        paramCount++;
      }

      const maintenanceSummaryQuery = `
            SELECT 
                COUNT(*) as total_requests,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_requests,
                COUNT(CASE WHEN status IN ('open', 'in_progress') THEN 1 END) as active_requests,
                COUNT(CASE WHEN priority = 'emergency' THEN 1 END) as emergency_requests,
                COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) as total_costs,
                COALESCE(SUM(actual_cost), 0) as actual_costs,
                COALESCE(SUM(estimated_cost), 0) as estimated_costs,
                COALESCE(AVG(COALESCE(actual_cost, estimated_cost)), 0) as avg_cost,
                
                -- Category breakdown
                COALESCE(SUM(CASE WHEN category = 'Plumbing' THEN COALESCE(actual_cost, estimated_cost) END), 0) as plumbing_costs,
                COALESCE(SUM(CASE WHEN category = 'Electrical' THEN COALESCE(actual_cost, estimated_cost) END), 0) as electrical_costs,
                COALESCE(SUM(CASE WHEN category = 'HVAC' THEN COALESCE(actual_cost, estimated_cost) END), 0) as hvac_costs,
                COALESCE(SUM(CASE WHEN category = 'Structural' THEN COALESCE(actual_cost, estimated_cost) END), 0) as structural_costs,
                COALESCE(SUM(CASE WHEN category = 'Other' THEN COALESCE(actual_cost, estimated_cost) END), 0) as other_costs
                
            FROM maintenance_requests mr
            LEFT JOIN units u ON mr.unit_id = u.id
            WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
            ${dateFilter}
            ${propertyFilter}
        `;

      const result = await client.query(maintenanceSummaryQuery, params);
      const summary = result.rows[0];

      const maintenanceSummary = {
        totalRequests: parseInt(summary.total_requests) || 0,
        completedRequests: parseInt(summary.completed_requests) || 0,
        activeRequests: parseInt(summary.active_requests) || 0,
        emergencyRequests: parseInt(summary.emergency_requests) || 0,
        totalCosts: parseFloat(summary.total_costs) || 0,
        actualCosts: parseFloat(summary.actual_costs) || 0,
        estimatedCosts: parseFloat(summary.estimated_costs) || 0,
        averageCost: parseFloat(summary.avg_cost) || 0,
        completionRate:
          summary.total_requests > 0
            ? Math.round(
                (summary.completed_requests / summary.total_requests) * 100
              )
            : 0,
        categoryBreakdown: {
          plumbing: parseFloat(summary.plumbing_costs) || 0,
          electrical: parseFloat(summary.electrical_costs) || 0,
          hvac: parseFloat(summary.hvac_costs) || 0,
          structural: parseFloat(summary.structural_costs) || 0,
          other: parseFloat(summary.other_costs) || 0,
        },
      };

      res.status(200).json({
        status: 200,
        message: "Maintenance summary retrieved successfully",
        data: { maintenanceSummary, period },
      });
    } catch (error) {
      console.error("❌ Maintenance summary error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch maintenance summary",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Monthly Data for Charts
router.get("/monthly-data", authenticateTokenSimple, async (req, res) => {
  console.log("📈 Monthly financial data route accessed");

  const client = await pool.connect();

  try {
    const months = parseInt(req.query.months) || 12;

    // Generate month series for the last N months
    const monthSeriesQuery = `
            SELECT 
                TO_CHAR(date_month, 'Mon') as month,
                date_month
            FROM (
                SELECT 
                    DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month' * generate_series(0, $1 - 1)) as date_month
            ) month_series
            ORDER BY date_month
        `;

    // Revenue data
    const revenueQuery = `
            SELECT 
                DATE_TRUNC('month', payment_date) as month_date,
                SUM(amount_paid) as revenue
            FROM rent_payments
            WHERE payment_status = 'paid'
            AND payment_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '${months} months')
            GROUP BY DATE_TRUNC('month', payment_date)
        `;

    // Expense data
    const expenseQuery = `
    SELECT 
        DATE_TRUNC('month', COALESCE(completed_date, requested_date)) as month_date,
        SUM(COALESCE(actual_cost, estimated_cost)) as expenses
    FROM maintenance_requests
    WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
    AND COALESCE(completed_date, requested_date) >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '${months} months')
    GROUP BY DATE_TRUNC('month', COALESCE(completed_date, requested_date))
`;

    // Maintenance breakdown
    const maintenanceQuery = `
        SELECT 
            DATE_TRUNC('month', COALESCE(completed_date, requested_date)) as month_date,
            SUM(CASE WHEN category IN ('Maintenance', 'Plumbing', 'Electrical', 'HVAC', 'Structural') 
                THEN COALESCE(actual_cost, estimated_cost) ELSE 0 END) as maintenance,
            SUM(CASE WHEN category IN ('Utilities', 'Cleaning') 
                THEN COALESCE(actual_cost, estimated_cost) ELSE 0 END) as utilities
        FROM maintenance_requests
        WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
        AND COALESCE(completed_date, requested_date) >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '${months} months')
        GROUP BY DATE_TRUNC('month', COALESCE(completed_date, requested_date))
    `;
    // Execute queries
    const [monthSeriesResult, revenueResult, expenseResult, maintenanceResult] =
      await Promise.all([
        client.query(monthSeriesQuery, [months]),
        client.query(revenueQuery),
        client.query(expenseQuery),
        client.query(maintenanceQuery),
      ]);

    console.log(revenueResult.rows);

    // Use month string as the key
    const revenueMap = new Map();
    revenueResult.rows.forEach((row) => {
      const key = new Date(row.month_date).toISOString().slice(0, 7); // YYYY-MM
      revenueMap.set(key, parseFloat(row.revenue) || 0);
    });

    const expenseMap = new Map();
    expenseResult.rows.forEach((row) => {
      const key = new Date(row.month_date).toISOString().slice(0, 7);
      expenseMap.set(key, parseFloat(row.expenses) || 0);
    });

    const maintenanceMap = new Map();
    const utilitiesMap = new Map();
    maintenanceResult.rows.forEach((row) => {
      const key = new Date(row.month_date).toISOString().slice(0, 7);
      maintenanceMap.set(key, parseFloat(row.maintenance) || 0);
      utilitiesMap.set(key, parseFloat(row.utilities) || 0);
    });

    // Build final array
    const monthlyData = monthSeriesResult.rows.map((row) => {
      const key = new Date(row.date_month).toISOString().slice(0, 7);
      return {
        month: row.month,
        revenue: revenueMap.get(key) || 0,
        expenses: expenseMap.get(key) || 0,
        maintenance: maintenanceMap.get(key) || 0,
        utilities: utilitiesMap.get(key) || 0,
      };
    });

    res.status(200).json({
      status: 200,
      message: "Monthly financial data retrieved successfully",
      data: { monthlyData },
    });
  } catch (error) {
    console.error("❌ Monthly data error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch monthly data",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Expense Breakdown for Pie Chart
router.get("/expense-breakdown", authenticateTokenSimple, async (req, res) => {
  console.log("🥧 Expense breakdown route accessed");

  const client = await pool.connect();

  try {
    const { period = "month" } = req.query;

    let dateFilter = "";
    let propertyFilter = "";
    if (period === "month") {
      dateFilter = `AND completed_date >= DATE_TRUNC('month', CURRENT_DATE)`;
    } else if (period === "quarter") {
      dateFilter = `AND completed_date >= DATE_TRUNC('quarter', CURRENT_DATE)`;
    } else if (period === "year") {
      dateFilter = `AND completed_date >= DATE_TRUNC('year', CURRENT_DATE)`;
    }

    const expenseBreakdownQuery = `
            WITH maintenance_expenses AS (
        SELECT 
            COALESCE(category, 'Other') as name,
            SUM(COALESCE(actual_cost, estimated_cost)) as value
        FROM maintenance_requests mr
        LEFT JOIN units u ON mr.unit_id = u.id
        WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
        ${dateFilter.replace("completed_date", "COALESCE(completed_date, requested_date)")}
        ${propertyFilter.replace("property_id", "u.property_id")}
        GROUP BY COALESCE(category, 'Other')
        HAVING SUM(COALESCE(actual_cost, estimated_cost)) > 0
    ),
            fixed_expenses AS (
                SELECT 'Property Tax' as name, 15000::DECIMAL as value
                UNION ALL
                SELECT 'Insurance' as name, 6000::DECIMAL as value
                UNION ALL
                SELECT 'Administrative' as name, 4000::DECIMAL as value
            )
            SELECT name, value
            FROM (
                SELECT name, value FROM maintenance_expenses
                UNION ALL
                SELECT name, value FROM fixed_expenses
            ) combined_expenses
            WHERE value > 0
            ORDER BY value DESC
        `;

    const result = await client.query(expenseBreakdownQuery);

    const expenseBreakdown = result.rows.map((row) => ({
      name: row.name,
      value: parseFloat(row.value) || 0,
    }));

    res.status(200).json({
      status: 200,
      message: "Expense breakdown retrieved successfully",
      data: { expenseBreakdown },
    });
  } catch (error) {
    console.error("❌ Expense breakdown error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch expense breakdown",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Recent Transactions
router.get(
  "/recent-transactions",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("📋 Recent transactions route accessed");

    const client = await pool.connect();

    try {
      const limit = parseInt(req.query.limit) || 20;

      const transactionsQuery = `
            WITH payment_transactions AS (
                SELECT 
                    rp.id,
                    rp.payment_date as date,
                    'Rent Payment - ' || COALESCE(p.property_name, 'Unknown Property') || 
                    CASE WHEN u.unit_number IS NOT NULL THEN ' Unit ' || u.unit_number ELSE '' END as description,
                    'Income' as type,
                    rp.amount_paid as amount,
                    'Rent' as category,
                    COALESCE(rp.payment_method, 'Unknown') as payment_method
                FROM rent_payments rp
                LEFT JOIN leases l ON rp.lease_id = l.id
                LEFT JOIN units u ON l.unit_id = u.id
                LEFT JOIN properties p ON u.property_id = p.id
                WHERE rp.payment_status = 'paid' AND rp.payment_date IS NOT NULL
            ),
            maintenance_transactions AS (
                SELECT 
                    mr.id,
                    mr.completed_date as date,
                    mr.request_title as description,
                    'Expense' as type,
                    mr.actual_cost as amount,
                    COALESCE(mr.category, 'Maintenance') as category,
                    'Cash' as payment_method
                FROM maintenance_requests mr
                WHERE mr.actual_cost IS NOT NULL AND mr.completed_date IS NOT NULL
            )
            SELECT 
                id,
                date,
                description,
                type,
                amount,
                category,
                payment_method
            FROM (
                SELECT * FROM payment_transactions
                UNION ALL
                SELECT * FROM maintenance_transactions
            ) all_transactions
            WHERE date IS NOT NULL
            ORDER BY date DESC
            LIMIT $1
        `;

      const result = await client.query(transactionsQuery, [limit]);

      const recentTransactions = result.rows.map((row) => ({
        id: row.id,
        date: row.date,
        description: row.description,
        type: row.type,
        amount: parseFloat(row.amount) || 0,
        category: row.category,
        paymentMethod: row.payment_method,
      }));

      res.status(200).json({
        status: 200,
        message: "Recent transactions retrieved successfully",
        data: { recentTransactions },
      });
    } catch (error) {
      console.error("❌ Recent transactions error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch recent transactions",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Generate Financial Report
router.post("/generate-report", authenticateTokenSimple, async (req, res) => {
  console.log("📄 Generate report route accessed");

  const client = await pool.connect();

  try {
    const {
      startDate,
      endDate,
      type = "detailed",
      includeCharts = true,
    } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        status: 400,
        message: "Start date and end date are required",
      });
    }

    // Validate date format
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        status: 400,
        message: "Invalid date format. Please use YYYY-MM-DD format.",
      });
    }

    if (start > end) {
      return res.status(400).json({
        status: 400,
        message: "Start date must be before end date",
      });
    }

    // Generate comprehensive report data
    const reportQuery = `
            WITH revenue_summary AS (
                SELECT 
                    COALESCE(SUM(amount_paid), 0) as total_revenue,
                    COUNT(*) as payment_count,
                    COALESCE(AVG(amount_paid), 0) as avg_payment
                FROM rent_payments
                WHERE payment_status = 'paid' 
                AND payment_date BETWEEN $1 AND $2
            ),
           expense_summary AS (
    SELECT 
        COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) as total_expenses,
        COUNT(*) as expense_count,
        COALESCE(AVG(COALESCE(actual_cost, estimated_cost)), 0) as avg_expense
    FROM maintenance_requests
    WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
    AND COALESCE(completed_date, requested_date) BETWEEN $1 AND $2
)
            SELECT 
                rs.total_revenue,
                rs.payment_count,
                rs.avg_payment,
                es.total_expenses,
                es.expense_count,
                es.avg_expense,
                (rs.total_revenue - es.total_expenses) as net_income
            FROM revenue_summary rs
            CROSS JOIN expense_summary es
        `;

    const propertyQuery = `
            SELECT 
                p.property_name,
                COUNT(DISTINCT u.id) as total_units,
                COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END) as occupied_units,
                COALESCE(SUM(rp.amount_paid), 0) as property_revenue
            FROM properties p
            LEFT JOIN units u ON p.id = u.property_id
            LEFT JOIN leases l ON u.id = l.unit_id AND l.lease_status = 'active'
            LEFT JOIN rent_payments rp ON l.id = rp.lease_id 
                AND rp.payment_status = 'paid' 
                AND rp.payment_date BETWEEN $1 AND $2
            GROUP BY p.id, p.property_name
            ORDER BY property_revenue DESC
        `;

    const [reportResult, propertyResult] = await Promise.all([
      client.query(reportQuery, [startDate, endDate]),
      client.query(propertyQuery, [startDate, endDate]),
    ]);

    const reportData = reportResult.rows[0];
    const propertyPerformance = propertyResult.rows;

    const report = {
      reportId: `RPT-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user?.username || req.user?.email || "Unknown",
      period: { startDate, endDate },
      type,
      includeCharts,
      summary: {
        totalRevenue: parseFloat(reportData.total_revenue) || 0,
        totalExpenses: parseFloat(reportData.total_expenses) || 0,
        netIncome: parseFloat(reportData.net_income) || 0,
        paymentCount: parseInt(reportData.payment_count) || 0,
        avgPayment: parseFloat(reportData.avg_payment) || 0,
        expenseCount: parseInt(reportData.expense_count) || 0,
        avgExpense: parseFloat(reportData.avg_expense) || 0,
      },
      propertyPerformance: propertyPerformance.map((prop) => ({
        propertyName: prop.property_name,
        totalUnits: parseInt(prop.total_units) || 0,
        occupiedUnits: parseInt(prop.occupied_units) || 0,
        revenue: parseFloat(prop.property_revenue) || 0,
        occupancyRate:
          prop.total_units > 0
            ? Math.round((prop.occupied_units / prop.total_units) * 100)
            : 0,
      })),
    };

    res.status(200).json({
      status: 200,
      message: "Financial report generated successfully",
      data: { report },
    });
  } catch (error) {
    console.error("❌ Generate report error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to generate financial report",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Export all financial data (for Excel/CSV)
router.get("/export", authenticateTokenSimple, async (req, res) => {
  console.log("📤 Export financial data route accessed");

  const client = await pool.connect();

  try {
    const { format = "json", startDate, endDate } = req.query;

    let dateFilter = "";
    let queryParams = [];

    if (startDate && endDate) {
      dateFilter = "WHERE payment_date BETWEEN $1 AND $2";
      queryParams = [startDate, endDate];
    } else {
      // Default to last 6 months if no dates provided
      dateFilter = "WHERE payment_date >= CURRENT_DATE - INTERVAL '6 months'";
    }

    const exportQuery = `
   SELECT 
        mr.requested_date::DATE as request_date,
        COALESCE(mr.completed_date::DATE, 'Pending') as completion_date,
        COALESCE(p.property_name, 'Unknown') as property_name,
        COALESCE(u.unit_number, 'N/A') as unit_number,
        mr.request_title,
        mr.category,
        mr.priority,
        mr.status,
        COALESCE(mr.actual_cost, mr.estimated_cost, 0) as cost,
        CASE WHEN mr.actual_cost IS NOT NULL THEN 'Actual' ELSE 'Estimated' END as cost_type
    FROM maintenance_requests mr
    LEFT JOIN units u ON mr.unit_id = u.id
    LEFT JOIN properties p ON u.property_id = p.id
    WHERE (mr.actual_cost IS NOT NULL OR mr.estimated_cost IS NOT NULL)
    ${dateFilter.replace("payment_date", "COALESCE(mr.completed_date, mr.requested_date)")}
    ORDER BY mr.requested_date DESC
    LIMIT 1000
        `;
    const result = await client.query(exportQuery, queryParams);

    if (format === "csv") {
      // Convert to CSV format
      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "No data found for export",
        });
      }

      const csvHeaders = [
        "Payment Date",
        "Property Name",
        "Unit Number",
        "Tenant Name",
        "Amount Due",
        "Amount Paid",
        "Payment Status",
        "Payment Method",
        "Late Fee",
        "Due Date",
      ].join(",");

      const csvRows = result.rows.map((row) => {
        return [
          row.payment_date ? row.payment_date.toISOString().split("T")[0] : "",
          `"${(row.property_name || "").replace(/"/g, '""')}"`,
          `"${(row.unit_number || "").replace(/"/g, '""')}"`,
          `"${(row.tenant_name || "").replace(/"/g, '""')}"`,
          row.amount_due || 0,
          row.amount_paid || 0,
          `"${(row.payment_status || "").replace(/"/g, '""')}"`,
          `"${(row.payment_method || "").replace(/"/g, '""')}"`,
          row.late_fee || 0,
          row.due_date ? row.due_date.toISOString().split("T")[0] : "",
        ].join(",");
      });

      const csvContent = [csvHeaders, ...csvRows].join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=financial-report.csv"
      );
      res.send("\ufeff" + csvContent); // Add BOM for Excel compatibility
    } else {
      res.status(200).json({
        status: 200,
        message: "Financial data exported successfully",
        data: {
          exportData: result.rows,
          totalRecords: result.rows.length,
          dateRange: { startDate, endDate },
        },
      });
    }
  } catch (error) {
    console.error("❌ Export error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to export financial data",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Additional endpoint for financial analytics
router.get("/analytics", authenticateTokenSimple, async (req, res) => {
  console.log("📊 Financial analytics route accessed");

  const client = await pool.connect();

  try {
    const { period = "year" } = req.query;

    let dateFilter = "";
    if (period === "month") {
      dateFilter = `AND payment_date >= DATE_TRUNC('month', CURRENT_DATE)`;
    } else if (period === "quarter") {
      dateFilter = `AND payment_date >= DATE_TRUNC('quarter', CURRENT_DATE)`;
    } else if (period === "year") {
      dateFilter = `AND payment_date >= DATE_TRUNC('year', CURRENT_DATE)`;
    }

    const analyticsQuery = `
            WITH revenue_analytics AS (
                SELECT 
                    COUNT(DISTINCT rp.lease_id) as active_leases_with_payments,
                    AVG(rp.amount_paid) as avg_rent_amount,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rp.amount_paid) as median_rent,
                    COUNT(CASE WHEN rp.payment_status = 'paid' AND rp.payment_date <= rp.due_date THEN 1 END) as on_time_payments,
                    COUNT(CASE WHEN rp.payment_status = 'paid' AND rp.payment_date > rp.due_date THEN 1 END) as late_payments,
                    COUNT(CASE WHEN rp.payment_status IN ('overdue', 'pending') THEN 1 END) as overdue_payments
                FROM rent_payments rp
                WHERE rp.payment_date IS NOT NULL OR rp.payment_status IN ('overdue', 'pending')
                ${dateFilter}
            ),
           expense_analytics AS (
    SELECT 
        COUNT(*) as total_maintenance_requests,
        AVG(COALESCE(actual_cost, estimated_cost)) as avg_maintenance_cost,
        SUM(CASE WHEN priority = 'emergency' THEN COALESCE(actual_cost, estimated_cost) ELSE 0 END) as emergency_costs,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_requests
    FROM maintenance_requests
    WHERE (actual_cost IS NOT NULL OR estimated_cost IS NOT NULL)
    AND COALESCE(completed_date, requested_date) >= DATE_TRUNC('${period}', CURRENT_DATE)
),
            property_analytics AS (
                SELECT 
                    COUNT(DISTINCT p.id) as total_properties,
                    AVG(unit_counts.unit_count) as avg_units_per_property,
                    SUM(unit_counts.occupied_count) as total_occupied_units,
                    SUM(unit_counts.unit_count) as total_units
                FROM properties p
                LEFT JOIN (
                    SELECT 
                        property_id,
                        COUNT(*) as unit_count,
                        COUNT(CASE WHEN occupancy_status = 'occupied' THEN 1 END) as occupied_count
                    FROM units
                    GROUP BY property_id
                ) unit_counts ON p.id = unit_counts.property_id
            )
            SELECT 
                ra.*,
                ea.*,
                pa.*,
                CASE 
                    WHEN (ra.on_time_payments + ra.late_payments + ra.overdue_payments) > 0 THEN
                        ROUND((ra.on_time_payments::DECIMAL / (ra.on_time_payments + ra.late_payments + ra.overdue_payments)) * 100, 2)
                    ELSE 0
                END as on_time_payment_rate,
                CASE 
                    WHEN pa.total_units > 0 THEN
                        ROUND((pa.total_occupied_units::DECIMAL / pa.total_units) * 100, 2)
                    ELSE 0
                END as overall_occupancy_rate
            FROM revenue_analytics ra
            CROSS JOIN expense_analytics ea
            CROSS JOIN property_analytics pa
        `;

    const result = await client.query(analyticsQuery);
    const analytics = result.rows[0];

    const analyticsData = {
      revenueMetrics: {
        activeLeasesWithPayments:
          parseInt(analytics.active_leases_with_payments) || 0,
        averageRentAmount: parseFloat(analytics.avg_rent_amount) || 0,
        medianRent: parseFloat(analytics.median_rent) || 0,
        onTimePayments: parseInt(analytics.on_time_payments) || 0,
        latePayments: parseInt(analytics.late_payments) || 0,
        overduePayments: parseInt(analytics.overdue_payments) || 0,
        onTimePaymentRate: parseFloat(analytics.on_time_payment_rate) || 0,
      },
      expenseMetrics: {
        totalMaintenanceRequests:
          parseInt(analytics.total_maintenance_requests) || 0,
        averageMaintenanceCost: parseFloat(analytics.avg_maintenance_cost) || 0,
        emergencyCosts: parseFloat(analytics.emergency_costs) || 0,
        completedRequests: parseInt(analytics.completed_requests) || 0,
        completionRate:
          analytics.total_maintenance_requests > 0
            ? Math.round(
                (analytics.completed_requests /
                  analytics.total_maintenance_requests) *
                  100
              )
            : 0,
      },
      propertyMetrics: {
        totalProperties: parseInt(analytics.total_properties) || 0,
        averageUnitsPerProperty:
          parseFloat(analytics.avg_units_per_property) || 0,
        totalOccupiedUnits: parseInt(analytics.total_occupied_units) || 0,
        totalUnits: parseInt(analytics.total_units) || 0,
        overallOccupancyRate: parseFloat(analytics.overall_occupancy_rate) || 0,
      },
      period: period,
    };

    res.status(200).json({
      status: 200,
      message: "Financial analytics retrieved successfully",
      data: { analytics: analyticsData },
    });
  } catch (error) {
    console.error("❌ Financial analytics error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch financial analytics",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Payment trends endpoint
router.get("/payment-trends", authenticateTokenSimple, async (req, res) => {
  console.log("📈 Payment trends route accessed");

  const client = await pool.connect();

  try {
    const { months = 6 } = req.query;

    const trendsQuery = `
            WITH monthly_trends AS (
                SELECT 
                    TO_CHAR(payment_date, 'YYYY-MM') as month,
                    TO_CHAR(payment_date, 'Mon YYYY') as month_label,
                    COUNT(*) as total_payments,
                    SUM(amount_paid) as total_revenue,
                    AVG(amount_paid) as avg_payment,
                    COUNT(CASE WHEN payment_date <= due_date THEN 1 END) as on_time_count,
                    COUNT(CASE WHEN payment_date > due_date THEN 1 END) as late_count,
                    SUM(late_fee) as total_late_fees
                FROM rent_payments
                WHERE payment_status = 'paid' 
                AND payment_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '${months} months')
                GROUP BY TO_CHAR(payment_date, 'YYYY-MM'), TO_CHAR(payment_date, 'Mon YYYY')
                ORDER BY month
            )
            SELECT 
                month_label,
                total_payments,
                total_revenue,
                avg_payment,
                on_time_count,
                late_count,
                total_late_fees,
                CASE 
                    WHEN total_payments > 0 THEN 
                        ROUND((on_time_count::DECIMAL / total_payments) * 100, 2)
                    ELSE 0
                END as on_time_percentage
            FROM monthly_trends
        `;

    const result = await client.query(trendsQuery);

    const paymentTrends = result.rows.map((row) => ({
      month: row.month_label,
      totalPayments: parseInt(row.total_payments) || 0,
      totalRevenue: parseFloat(row.total_revenue) || 0,
      averagePayment: parseFloat(row.avg_payment) || 0,
      onTimeCount: parseInt(row.on_time_count) || 0,
      lateCount: parseInt(row.late_count) || 0,
      totalLateFees: parseFloat(row.total_late_fees) || 0,
      onTimePercentage: parseFloat(row.on_time_percentage) || 0,
    }));

    res.status(200).json({
      status: 200,
      message: "Payment trends retrieved successfully",
      data: { paymentTrends },
    });
  } catch (error) {
    console.error("❌ Payment trends error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch payment trends",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Property financial performance endpoint
router.get(
  "/property-performance",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("🏢 Property performance route accessed");

    const client = await pool.connect();

    try {
      const { period = "month" } = req.query;

      let dateFilter = "";
      if (period === "month") {
        dateFilter = `AND rp.payment_date >= DATE_TRUNC('month', CURRENT_DATE)`;
      } else if (period === "quarter") {
        dateFilter = `AND rp.payment_date >= DATE_TRUNC('quarter', CURRENT_DATE)`;
      } else if (period === "year") {
        dateFilter = `AND rp.payment_date >= DATE_TRUNC('year', CURRENT_DATE)`;
      }

      const performanceQuery = `
            SELECT 
                p.id,
                p.property_name,
                p.property_type,
                COUNT(DISTINCT u.id) as total_units,
                COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END) as occupied_units,
                COUNT(CASE WHEN u.occupancy_status = 'vacant' THEN 1 END) as vacant_units,
                COALESCE(SUM(rp.amount_paid), 0) as total_revenue,
                COALESCE(AVG(rp.amount_paid), 0) as avg_rent_per_unit,
                COALESCE(SUM(COALESCE(mr.actual_cost, mr.estimated_cost)), 0) as maintenance_costs,
                COUNT(DISTINCT rp.id) as payment_count,
                COUNT(DISTINCT mr.id) as maintenance_request_count,
                CASE 
                    WHEN COUNT(DISTINCT u.id) > 0 THEN 
                        ROUND((COUNT(CASE WHEN u.occupancy_status = 'occupied' THEN 1 END)::DECIMAL / COUNT(DISTINCT u.id)) * 100, 2)
                    ELSE 0
                END as occupancy_rate,
                COALESCE(SUM(rp.amount_paid), 0) - COALESCE(SUM(mr.actual_cost), 0) as net_income
            FROM properties p
            LEFT JOIN units u ON p.id = u.property_id
            LEFT JOIN leases l ON u.id = l.unit_id AND l.lease_status = 'active'
            LEFT JOIN rent_payments rp ON l.id = rp.lease_id 
                AND rp.payment_status = 'paid' ${dateFilter}
            LEFT JOIN maintenance_requests mr ON u.id = mr.unit_id 
    AND (mr.actual_cost IS NOT NULL OR mr.estimated_cost IS NOT NULL)
    AND COALESCE(mr.completed_date, mr.requested_date) >= DATE_TRUNC('${period}', CURRENT_DATE)
            GROUP BY p.id, p.property_name, p.property_type
            ORDER BY total_revenue DESC
        `;

      const result = await client.query(performanceQuery);

      const propertyPerformance = result.rows.map((row) => ({
        propertyId: row.id,
        propertyName: row.property_name,
        propertyType: row.property_type,
        totalUnits: parseInt(row.total_units) || 0,
        occupiedUnits: parseInt(row.occupied_units) || 0,
        vacantUnits: parseInt(row.vacant_units) || 0,
        occupancyRate: parseFloat(row.occupancy_rate) || 0,
        totalRevenue: parseFloat(row.total_revenue) || 0,
        averageRentPerUnit: parseFloat(row.avg_rent_per_unit) || 0,
        maintenanceCosts: parseFloat(row.maintenance_costs) || 0,
        netIncome: parseFloat(row.net_income) || 0,
        paymentCount: parseInt(row.payment_count) || 0,
        maintenanceRequestCount: parseInt(row.maintenance_request_count) || 0,
        profitMargin:
          row.total_revenue > 0
            ? Math.round((row.net_income / row.total_revenue) * 100)
            : 0,
      }));

      res.status(200).json({
        status: 200,
        message: "Property performance retrieved successfully",
        data: { propertyPerformance, period },
      });
    } catch (error) {
      console.error("❌ Property performance error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to fetch property performance",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Test route for debugging
router.get("/test", async (req, res) => {
  console.log("🧪 Financial test route accessed");

  try {
    const client = await pool.connect();

    try {
      const result = await client.query(`
                SELECT 
                    COUNT(*) as total_properties,
                    (SELECT COUNT(*) FROM units) as total_units,
                    (SELECT COUNT(*) FROM tenants) as total_tenants,
                    (SELECT COUNT(*) FROM leases) as total_leases,
                    (SELECT COUNT(*) FROM rent_payments) as total_payments
                FROM properties
            `);

      res.status(200).json({
        status: 200,
        message: "Financial routes test successful",
        data: {
          databaseStats: result.rows[0],
          timestamp: new Date().toISOString(),
          environment: process.env.NODE_ENV || "development",
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

// Add these routes to your existing financialReports.js file

// Get all property expenses
router.get("/property-expenses", authenticateTokenSimple, async (req, res) => {
  console.log("📋 Property expenses route accessed");

  const client = await pool.connect();

  try {
    const { propertyId } = req.query;

    let query = `
            SELECT 
                pe.id,
                pe.property_id,
                p.property_name,
                pe.expense_type,
                pe.amount,
                pe.frequency,
                pe.start_date,
                pe.end_date,
                pe.is_active,
                pe.description,
                pe.created_at,
                pe.updated_at,
                ec.category_name,
                CASE 
                    WHEN pe.frequency = 'monthly' THEN pe.amount
                    WHEN pe.frequency = 'quarterly' THEN pe.amount / 3
                    WHEN pe.frequency = 'annual' THEN pe.amount / 12
                    ELSE pe.amount
                END as monthly_equivalent
            FROM property_expenses pe
            JOIN properties p ON pe.property_id = p.id
            LEFT JOIN expense_categories ec ON pe.category_id = ec.id
            WHERE pe.is_active = true
        `;

    const params = [];
    if (propertyId) {
      query += ` AND pe.property_id = $1`;
      params.push(propertyId);
    }

    query += ` ORDER BY p.property_name, pe.expense_type`;

    const result = await client.query(query, params);

    const propertyExpenses = result.rows.map((row) => ({
      id: row.id,
      propertyId: row.property_id,
      propertyName: row.property_name,
      expenseType: row.expense_type,
      amount: parseFloat(row.amount),
      frequency: row.frequency,
      monthlyEquivalent: parseFloat(row.monthly_equivalent),
      startDate: row.start_date,
      endDate: row.end_date,
      isActive: row.is_active,
      description: row.description,
      categoryName: row.category_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    res.status(200).json({
      status: 200,
      message: "Property expenses retrieved successfully",
      data: { propertyExpenses },
    });
  } catch (error) {
    console.error("❌ Property expenses error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch property expenses",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Create new property expense
router.post("/property-expenses", authenticateTokenSimple, async (req, res) => {
  console.log("➕ Create property expense route accessed");

  const client = await pool.connect();

  try {
    const {
      propertyId,
      expenseType,
      amount,
      frequency = "monthly",
      startDate,
      endDate,
      description,
      categoryId,
    } = req.body;

    // Validation
    if (!propertyId || !expenseType || !amount) {
      return res.status(400).json({
        status: 400,
        message: "Property ID, expense type, and amount are required",
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        status: 400,
        message: "Amount must be greater than 0",
      });
    }

    const insertQuery = `
            INSERT INTO property_expenses (
                property_id, expense_type, amount, frequency, 
                start_date, end_date, description, category_id, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, property_id, expense_type, amount, frequency, 
                     start_date, end_date, description, is_active, created_at
        `;

    const params = [
      propertyId,
      expenseType,
      amount,
      frequency,
      startDate || new Date().toISOString().split("T")[0],
      endDate || null,
      description || null,
      categoryId || null,
      req.user?.username || req.user?.email || "system",
    ];

    const result = await client.query(insertQuery, params);
    const newExpense = result.rows[0];

    res.status(201).json({
      status: 201,
      message: "Property expense created successfully",
      data: {
        expense: {
          id: newExpense.id,
          propertyId: newExpense.property_id,
          expenseType: newExpense.expense_type,
          amount: parseFloat(newExpense.amount),
          frequency: newExpense.frequency,
          startDate: newExpense.start_date,
          endDate: newExpense.end_date,
          description: newExpense.description,
          isActive: newExpense.is_active,
          createdAt: newExpense.created_at,
        },
      },
    });
  } catch (error) {
    console.error("❌ Create property expense error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to create property expense",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Update property expense
router.put(
  "/property-expenses/:id",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("✏️ Update property expense route accessed");

    const client = await pool.connect();

    try {
      const { id } = req.params;
      const {
        expenseType,
        amount,
        frequency,
        startDate,
        endDate,
        description,
        isActive,
        categoryId,
      } = req.body;

      // Build dynamic update query
      const updateFields = [];
      const params = [];
      let paramCount = 1;

      if (expenseType !== undefined) {
        updateFields.push(`expense_type = $${paramCount++}`);
        params.push(expenseType);
      }
      if (amount !== undefined) {
        if (amount <= 0) {
          return res.status(400).json({
            status: 400,
            message: "Amount must be greater than 0",
          });
        }
        updateFields.push(`amount = $${paramCount++}`);
        params.push(amount);
      }
      if (frequency !== undefined) {
        updateFields.push(`frequency = $${paramCount++}`);
        params.push(frequency);
      }
      if (startDate !== undefined) {
        updateFields.push(`start_date = $${paramCount++}`);
        params.push(startDate);
      }
      if (endDate !== undefined) {
        updateFields.push(`end_date = $${paramCount++}`);
        params.push(endDate);
      }
      if (description !== undefined) {
        updateFields.push(`description = $${paramCount++}`);
        params.push(description);
      }
      if (isActive !== undefined) {
        updateFields.push(`is_active = $${paramCount++}`);
        params.push(isActive);
      }
      if (categoryId !== undefined) {
        updateFields.push(`category_id = $${paramCount++}`);
        params.push(categoryId);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({
          status: 400,
          message: "No fields to update",
        });
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      params.push(id);

      const updateQuery = `
            UPDATE property_expenses 
            SET ${updateFields.join(", ")}
            WHERE id = $${paramCount}
            RETURNING id, property_id, expense_type, amount, frequency, 
                     start_date, end_date, description, is_active, updated_at
        `;

      const result = await client.query(updateQuery, params);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Property expense not found",
        });
      }

      const updatedExpense = result.rows[0];

      res.status(200).json({
        status: 200,
        message: "Property expense updated successfully",
        data: {
          expense: {
            id: updatedExpense.id,
            propertyId: updatedExpense.property_id,
            expenseType: updatedExpense.expense_type,
            amount: parseFloat(updatedExpense.amount),
            frequency: updatedExpense.frequency,
            startDate: updatedExpense.start_date,
            endDate: updatedExpense.end_date,
            description: updatedExpense.description,
            isActive: updatedExpense.is_active,
            updatedAt: updatedExpense.updated_at,
          },
        },
      });
    } catch (error) {
      console.error("❌ Update property expense error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to update property expense",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Delete (deactivate) property expense
router.delete(
  "/property-expenses/:id",
  authenticateTokenSimple,
  async (req, res) => {
    console.log("🗑️ Delete property expense route accessed");

    const client = await pool.connect();

    try {
      const { id } = req.params;
      const { hardDelete = false } = req.query;

      let query;
      if (hardDelete === "true") {
        query = `DELETE FROM property_expenses WHERE id = $1 RETURNING id`;
      } else {
        query = `
                UPDATE property_expenses 
                SET is_active = false, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1 
                RETURNING id, is_active
            `;
      }

      const result = await client.query(query, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: "Property expense not found",
        });
      }

      res.status(200).json({
        status: 200,
        message:
          hardDelete === "true"
            ? "Property expense deleted permanently"
            : "Property expense deactivated successfully",
        data: { id: result.rows[0].id },
      });
    } catch (error) {
      console.error("❌ Delete property expense error:", error);
      res.status(500).json({
        status: 500,
        message: "Failed to delete property expense",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    } finally {
      client.release();
    }
  }
);

// Get expense categories
router.get("/expense-categories", authenticateTokenSimple, async (req, res) => {
  console.log("📂 Expense categories route accessed");

  const client = await pool.connect();

  try {
    const query = `
            SELECT id, category_name, description, is_active, created_at
            FROM expense_categories
            WHERE is_active = true
            ORDER BY category_name
        `;

    const result = await client.query(query);

    const categories = result.rows.map((row) => ({
      id: row.id,
      categoryName: row.category_name,
      description: row.description,
      isActive: row.is_active,
      createdAt: row.created_at,
    }));

    res.status(200).json({
      status: 200,
      message: "Expense categories retrieved successfully",
      data: { categories },
    });
  } catch (error) {
    console.error("❌ Expense categories error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch expense categories",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// UPDATE THE EXISTING expense-breakdown route to use the new table
router.get("/expense-breakdown", authenticateTokenSimple, async (req, res) => {
  console.log("🥧 Expense breakdown route accessed (updated)");

  const client = await pool.connect();

  try {
    const { period = "month", propertyId } = req.query;

    let dateFilter = "";
    let propertyFilter = "";
    const params = [];
    let paramCount = 1;

    // Date filtering
    if (period === "month") {
      dateFilter = `AND completed_date >= DATE_TRUNC('month', CURRENT_DATE)`;
    } else if (period === "quarter") {
      dateFilter = `AND completed_date >= DATE_TRUNC('quarter', CURRENT_DATE)`;
    } else if (period === "year") {
      dateFilter = `AND completed_date >= DATE_TRUNC('year', CURRENT_DATE)`;
    }

    // Property filtering
    if (propertyId) {
      propertyFilter = `AND property_id = $${paramCount}`;
      params.push(propertyId);
      paramCount++;
    }

    const expenseBreakdownQuery = `
            WITH maintenance_expenses AS (
                SELECT 
                    COALESCE(category, 'Other') as name,
                    SUM(actual_cost) as value
                FROM maintenance_requests mr
                LEFT JOIN units u ON mr.unit_id = u.id
                WHERE actual_cost IS NOT NULL AND completed_date IS NOT NULL
                ${dateFilter}
                ${propertyFilter.replace("property_id", "u.property_id")}
                GROUP BY COALESCE(category, 'Other')
                HAVING SUM(actual_cost) > 0
            ),
            property_expenses AS (
                SELECT 
                    pe.expense_type as name,
                    SUM(
                        CASE 
                            WHEN pe.frequency = 'monthly' THEN pe.amount
                            WHEN pe.frequency = 'quarterly' THEN pe.amount / 3
                            WHEN pe.frequency = 'annual' THEN pe.amount / 12
                            ELSE pe.amount
                        END
                    ) as value
                FROM property_expenses pe
                WHERE pe.is_active = true
                AND (pe.end_date IS NULL OR pe.end_date >= CURRENT_DATE)
                ${propertyFilter}
                GROUP BY pe.expense_type
                HAVING SUM(
                    CASE 
                        WHEN pe.frequency = 'monthly' THEN pe.amount
                        WHEN pe.frequency = 'quarterly' THEN pe.amount / 3
                        WHEN pe.frequency = 'annual' THEN pe.amount / 12
                        ELSE pe.amount
                    END
                ) > 0
            )
            SELECT name, value
            FROM (
                SELECT name, value FROM maintenance_expenses
                UNION ALL
                SELECT name, value FROM property_expenses
            ) combined_expenses
            WHERE value > 0
            ORDER BY value DESC
        `;

    const result = await client.query(expenseBreakdownQuery, params);

    const expenseBreakdown = result.rows.map((row) => ({
      name: row.name,
      value: parseFloat(row.value) || 0,
    }));

    res.status(200).json({
      status: 200,
      message: "Expense breakdown retrieved successfully",
      data: { expenseBreakdown },
    });
  } catch (error) {
    console.error("❌ Expense breakdown error:", error);
    res.status(500).json({
      status: 500,
      message: "Failed to fetch expense breakdown",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

export default router;
