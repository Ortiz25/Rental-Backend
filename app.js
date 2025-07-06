import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from "./src/config/constants.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import loginRoutes from "./src/routes/login.js";
import authRoutes from "./src/routes/auth.js";
import dashRoutes from "./src/routes/dashboard.js";
import propertyRoutes from "./src/routes/property.js";
import tenantRoutes from "./src/routes/tenant.js";
import leaseRoutes from "./src/routes/lease.js";
import supportLeaseRoutes from "./src/routes/supportLease.js";
import maintenanceRotes from "./src/routes/maintenance.js"
import userRoutes from "./src/routes/usermgt.js"
import communicationRoutes from "./src/routes/communication.js"
import paymentRoutes from "./src/routes/payments.js"
import financialRoutes from "./src/routes/financialReports.js"
import tenantDashRoutes from "./src/routes/tenantDashboard.js"
import rentCollectionRoutes from "./src/routes/rentCollectionRoutes.js"
import paymentVerificationRoutes from "./src/routes/paymentVerificatioRoutes.js"
import docmentRoutes from "./src/routes/documents.js"

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
});
//app.use(limiter);

// Routes
app.use("/api/login", loginRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashRoutes);
app.use("/api/properties", propertyRoutes);
app.use("/api/tenants", tenantRoutes);
app.use("/api/leases", leaseRoutes);
app.use("/api/support-lease", supportLeaseRoutes);
app.use("/api/maintenance", maintenanceRotes);
app.use("/api/usermgt", userRoutes);
app.use("/api/communications", communicationRoutes);
app.use("/api/rent-collection", paymentRoutes);
app.use("/api/financial", financialRoutes);
app.use("/api/tenant-dash", tenantDashRoutes);
app.use('/api/rent', rentCollectionRoutes);
app.use('/api/payment-verification', paymentVerificationRoutes)
app.use('/api/documents', docmentRoutes)



// app.use('/api/auth', authRoutes);
// app.use('/api/students', studentRoutes);
// app.use('/api/teachers', teacherRoutes);
// app.use('/api/classes', classRoutes);
// app.use('/api/attendance', attendanceRoutes);
// app.use('/api/dashboard', dashRoutes);
// app.use('/api/academic', academicRoutes);
// app.use('/api/hostels', hostelRoutes);
// app.use('/api/hostel-transport', transportRoutes);
// app.use('/api/library', libraryRoutes);
// app.use('/api/timetable', timetableRoutes);
// app.use('/api/subjects', subjectsRoutes);
// app.use('/api/rooms', roomRoutes);
// app.use('/api/leaves', leaveRoutes);
// app.use('/api/leavetypes', leaveTypeRoutes);
// app.use('/api/allocations', allocationsRoutes);
// app.use('/api/sessions', academicSessionsRoutes);
// app.use('/api/helpers', helperRoutes);
// app.use('/api/exams', examsRoutes);
// app.use('/api/examgrading', examGrading);
// app.use('/api/grading', gradingRoutes);
// app.use('/api/analytics', analyticsRoutes);
// app.use('/api/disciplinary', discplinaryRoutes);
// app.use('/api/communications', communicationRoutes);
// app.use('/api/events', eventsRoutes);
// app.use('/api/users', usersRoutes);
// app.use('/api/inventory', inventoryRoutes);
// app.use('/api/finance', financeRoutes);
// app.use('/api/yearly', yearlyRoutes);
// app.use('/api/password', passwordMgt);
// app.use('/api/academic-settings', academicSettingsRoutes);
// app.use('/api/examinations', examinationSettingsRoutes);
// app.use('/api/school-structure', schoolStructuresRoutes);
// app.use('/api/subjects-settings', subjectSettings);

// Error handling
app.use(errorHandler);

app.get("/", async (req, res, next) => {
  res.json({ message: "RMS Backend Route" });
});

export default app;
