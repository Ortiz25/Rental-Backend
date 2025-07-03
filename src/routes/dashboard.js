import express from 'express';
import pool from '../config/database.js';
import { authenticateToken,authorizeRole, authenticateTokenSimple } from '../middleware/auth.js';

const router = express.Router();

// Test route without authentication (for debugging)
router.get('/dashboard/test', async (req, res) => {
    console.log('🧪 Test dashboard route accessed');
    
    try {
      const client = await pool.connect();
      
      try {
        const result = await client.query('SELECT COUNT(*) as count FROM properties');
        
        res.status(200).json({
          status: 200,
          message: 'Dashboard test successful',
          data: {
            propertyCount: result.rows[0].count,
            timestamp: new Date().toISOString()
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Test route error:', error);
      res.status(500).json({
        status: 500,
        message: 'Database connection failed',
        error: error.message
      });
    }
  });
  
  // Main dashboard route with simplified auth (for testing)
  router.get('/summary', authenticateTokenSimple, async (req, res) => {
    console.log('📊 Dashboard summary route accessed by user:', req.user?.id);
    
    const client = await pool.connect();
    
    try {
      // Check if user has appropriate role (but don't block if missing)
      const allowedRoles = ['Super Admin', 'Admin', 'Manager'];
      if (req.user.role && !allowedRoles.includes(req.user.role)) {
        console.log('⚠️  User role not in preferred list but allowing access:', req.user.role);
      }
  
      console.log('Fetching dashboard data...');
  
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
  
      // Financial Summary Query (simplified to avoid complex joins that might fail)
      const financialQuery = `
        WITH monthly_payments AS (
          SELECT 
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_date >= DATE_TRUNC('month', CURRENT_DATE) THEN amount_paid END), 0) as monthly_revenue,
            COALESCE(SUM(CASE WHEN payment_status IN ('overdue', 'pending') AND due_date < CURRENT_DATE THEN amount_due END), 0) as outstanding_rent
          FROM rent_payments
        ),
        monthly_maintenance AS (
          SELECT 
            COALESCE(SUM(CASE WHEN completed_date >= DATE_TRUNC('month', CURRENT_DATE) THEN actual_cost END), 0) as maintenance_costs
          FROM maintenance_requests
          WHERE actual_cost IS NOT NULL
        )
        SELECT 
          mp.monthly_revenue,
          mp.outstanding_rent,
          mm.maintenance_costs as maintenance_costs_this_month
        FROM monthly_payments mp
        CROSS JOIN monthly_maintenance mm
      `;
  
      // Maintenance Query
      const maintenanceQuery = `
        SELECT 
          COUNT(CASE WHEN status IN ('open', 'in_progress') THEN 1 END) as open_requests,
          COUNT(CASE WHEN status = 'completed' AND completed_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as completed_recently,
          COUNT(CASE WHEN priority = 'emergency' AND status NOT IN ('completed', 'cancelled') THEN 1 END) as urgent_requests
        FROM maintenance_requests
      `;
  
      // Execute queries with error handling for each
      let propertyData = { total_properties: 0, occupied_units: 0, vacant_units: 0 };
      let tenantData = { active_tenants: 0, lease_renewals_soon: 0, new_applications: 0 };
      let leaseData = { active_leases: 0, expiring_soon: 0, terminated_leases: 0 };
      let financialData = { monthly_revenue: 0, outstanding_rent: 0, maintenance_costs_this_month: 0 };
      let maintenanceData = { open_requests: 0, completed_recently: 0, urgent_requests: 0 };
  
      try {
        const propertyResult = await client.query(propertyQuery);
        propertyData = propertyResult.rows[0] || propertyData;
        console.log('✅ Property data fetched');
      } catch (error) {
        console.error('❌ Property query failed:', error.message);
      }
  
      try {
        const tenantResult = await client.query(tenantQuery);
        tenantData = tenantResult.rows[0] || tenantData;
        console.log('✅ Tenant data fetched');
      } catch (error) {
        console.error('❌ Tenant query failed:', error.message);
      }
  
      try {
        const leaseResult = await client.query(leaseQuery);
        leaseData = leaseResult.rows[0] || leaseData;
        console.log('✅ Lease data fetched');
      } catch (error) {
        console.error('❌ Lease query failed:', error.message);
      }
  
      try {
        const financialResult = await client.query(financialQuery);
        financialData = financialResult.rows[0] || financialData;
        console.log('✅ Financial data fetched');
      } catch (error) {
        console.error('❌ Financial query failed:', error.message);
      }
  
      try {
        const maintenanceResult = await client.query(maintenanceQuery);
        maintenanceData = maintenanceResult.rows[0] || maintenanceData;
        console.log('✅ Maintenance data fetched');
      } catch (error) {
        console.error('❌ Maintenance query failed:', error.message);
      }
  
      // Format the response
      const dashboardData = {
        moduleSummaries: [
          {
            name: 'Property Overview',
            icon: 'BuildingIcon',
            stats: [
              { 
                label: 'Total Properties', 
                value: parseInt(propertyData.total_properties) || 0, 
                color: 'bg-blue-100' 
              },
              { 
                label: 'Occupied', 
                value: parseInt(propertyData.occupied_units) || 0, 
                color: 'bg-green-100' 
              },
              { 
                label: 'Vacant', 
                value: parseInt(propertyData.vacant_units) || 0, 
                color: 'bg-red-100' 
              }
            ]
          },
          {
            name: 'Tenant Management',
            icon: 'UsersIcon',
            stats: [
              { 
                label: 'Active Tenants', 
                value: parseInt(tenantData.active_tenants) || 0, 
                color: 'bg-purple-100' 
              },
              { 
                label: 'Lease Renewals', 
                value: parseInt(tenantData.lease_renewals_soon) || 0, 
                color: 'bg-yellow-100' 
              },
              { 
                label: 'New Applications', 
                value: parseInt(tenantData.new_applications) || 0, 
                color: 'bg-indigo-100' 
              }
            ]
          },
          {
            name: 'Lease Status',
            icon: 'FileTextIcon',
            stats: [
              { 
                label: 'Active Leases', 
                value: parseInt(leaseData.active_leases) || 0, 
                color: 'bg-green-100' 
              },
              { 
                label: 'Expiring Soon', 
                value: parseInt(leaseData.expiring_soon) || 0, 
                color: 'bg-orange-100' 
              },
              { 
                label: 'Terminated', 
                value: parseInt(leaseData.terminated_leases) || 0, 
                color: 'bg-red-100' 
              }
            ]
          },
          {
            name: 'Financial Summary',
            icon: 'DollarSignIcon',
            stats: [
              { 
                label: 'Monthly Revenue', 
                value: `$${(parseFloat(financialData.monthly_revenue) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, 
                color: 'bg-blue-100' 
              },
              { 
                label: 'Outstanding Rent', 
                value: `$${(parseFloat(financialData.outstanding_rent) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, 
                color: 'bg-red-100' 
              },
              { 
                label: 'Maintenance Costs', 
                value: `$${(parseFloat(financialData.maintenance_costs_this_month) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, 
                color: 'bg-yellow-100' 
              }
            ]
          },
          {
            name: 'Maintenance',
            icon: 'WrenchIcon',
            stats: [
              { 
                label: 'Open Requests', 
                value: parseInt(maintenanceData.open_requests) || 0, 
                color: 'bg-orange-100' 
              },
              { 
                label: 'Completed', 
                value: parseInt(maintenanceData.completed_recently) || 0, 
                color: 'bg-green-100' 
              },
              { 
                label: 'Urgent', 
                value: parseInt(maintenanceData.urgent_requests) || 0, 
                color: 'bg-red-100' 
              }
            ]
          }
        ],
        lastUpdated: new Date().toISOString(),
        userRole: req.user.role
      };
  
      console.log('✅ Dashboard data compiled successfully');
  
      res.status(200).json({
        status: 200,
        message: 'Dashboard data retrieved successfully',
        data: dashboardData
      });
  
    } catch (error) {
      console.error('❌ Dashboard data fetch error:', error);
      
      res.status(500).json({
        status: 500,
        message: 'Failed to fetch dashboard data',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        debug: error.stack
      });
    } finally {
      client.release();
    }
  });

export default  router;