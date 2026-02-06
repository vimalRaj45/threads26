import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import pg from 'pg';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import path from 'path';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'url';
import fs from 'fs';
import moment from 'moment';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const { Pool } = pg;
const fastify = Fastify({ 
  logger: true,
  bodyLimit: 10485760
});

// -------------------- PostgreSQL Setup --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_AfPar8WIF1jl@ep-late-unit-aili6pkq-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Event dates (for auto-close feature)
const EVENT_DATES = {
  workshop_day: moment().add(5, 'days').format('YYYY-MM-DD'), // Day 1 (5 days from today)
  event_day: moment().add(6, 'days').format('YYYY-MM-DD'),    // Day 2 (6 days from today)
  registration_closes: moment().add(4, 'days').format('YYYY-MM-DD') // Day before event (4 days from today)
};
const generateRegistrationID = async (participantId, isWorkshop = false) => {
  const prefix = isWorkshop ? 'THREADS26-WS-' : 'THREADS26-EV-';
  
  const participant = await pool.query(
    'SELECT department FROM participants WHERE participant_id = $1',
    [participantId]
  );
  
  const deptCode = participant.rows[0]?.department === 'CSE' ? 'CSE' : 'OTH';
  
  // ✅ Simple timestamp ensures uniqueness
  const timestamp = Date.now().toString().slice(-9); // Last 9 digits of timestamp
  
  // Format: THREADS26-WS-CSE-123456789
  return `${prefix}${deptCode}-${timestamp}`;
};

const checkSeatAvailability = async (eventId, department) => {
  const event = await pool.query('SELECT * FROM events WHERE event_id = $1', [eventId]);
  
  if (!event.rows[0]) throw new Error('Event not found');
  
  // Check if registration should be closed
  const today = moment().format('YYYY-MM-DD');
  if (today > EVENT_DATES.registration_closes) {
    throw new Error('Registration closed for this event');
  }
  
  if (department === 'CSE') {
    return event.rows[0].cse_available_seats > 0;
  } else {
    return event.rows[0].available_seats > 0;
  }
};

const updateSeats = async (eventId, department, increment = false) => {
  const op = increment ? '+' : '-';
  
  if (department === 'CSE') {
    await pool.query(
      `UPDATE events SET cse_available_seats = cse_available_seats ${op} 1 WHERE event_id = $1`,
      [eventId]
    );
  }
  
  await pool.query(
    `UPDATE events SET available_seats = available_seats ${op} 1 WHERE event_id = $1`,
    [eventId]
  );
};

const sendEmail = async (to, subject, html) => {
  // In production, use SendGrid/NodeMailer
  console.log(`Email to ${to}: ${subject}`);
  return true;
};

const sendWhatsApp = async (phone, message) => {
  // Integrate with WhatsApp Business API or Twilio
  console.log(`WhatsApp to ${phone}: ${message}`);
  return true;
};



// -------------------- Plugin Registration --------------------
await fastify.register(cors, { origin: '*' });
await fastify.register(formbody);
await fastify.register(multipart);
await fastify.register(staticPlugin, {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
});

// -------------------- API Routes --------------------

// 1. Get Event Dates & Countdown
fastify.get('/api/event-dates', async () => {
  const today = moment();
  const workshopDate = moment(EVENT_DATES.workshop_day);
  const eventDate = moment(EVENT_DATES.event_day);
  
  return {
    workshop_day: EVENT_DATES.workshop_day,
    event_day: EVENT_DATES.event_day,
    registration_closes: EVENT_DATES.registration_closes,
    countdown: {
      days_to_workshop: workshopDate.diff(today, 'days'),
      days_to_event: eventDate.diff(today, 'days'),
      is_registration_open: today.isBefore(moment(EVENT_DATES.registration_closes))
    }
  };
});

// 2. Get All Events with Live Seat Availability
fastify.get('/api/events', async (request) => {
  try {
    const { day, type } = request.query;
    let query = `
      SELECT 
        event_id, event_name, event_type, day, fee,
        description, duration, speaker, rules,
        total_seats, available_seats, cse_seats, cse_available_seats,
        is_active,
        CASE 
          WHEN available_seats = 0 THEN 'Sold Out'
          WHEN available_seats < 10 THEN 'Limited Seats'
          ELSE 'Available'
        END as seat_status
      FROM events 
      WHERE is_active = true
    `;
    
    const params = [];
    
    if (day) {
      query += ` AND day = $${params.length + 1}`;
      params.push(day);
    }
    if (type) {
      query += ` AND event_type = $${params.length + 1}`;
      params.push(type);
    }
    
    query += ' ORDER BY day, event_type, event_id';
    const result = await pool.query(query, params);
    
    return {
      events: result.rows,
      registration_open: moment().isBefore(moment(EVENT_DATES.registration_closes))
    };
  } catch (error) {
    fastify.log.error(error);
    throw new Error('Failed to fetch events');
  }
});

// 3. Register Participant (UNIFIED FORM)
fastify.post('/api/register', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      full_name,
      email,
      phone,
      college_name,
      department,
      year_of_study,
      city,
      state,
      accommodation_required = false,
      workshop_selections = [],
      event_selections = []
    } = request.body;
    
    const today = moment();
    if (today.isAfter(moment(EVENT_DATES.registration_closes))) {
      throw new Error('Registration is closed. Please contact organizers.');
    }
    
    const existing = await client.query(
      'SELECT * FROM participants WHERE email = $1',
      [email]
    );
    
    if (existing.rows.length > 0) {
      throw new Error('Email already registered');
    }
    
    const participantResult = await client.query(
      `INSERT INTO participants (
        full_name, email, phone, college_name, department,
        year_of_study, city, state, accommodation_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING participant_id`,
      [full_name, email, phone, college_name, department,
       year_of_study, city, state, accommodation_required]
    );
    
    const participantId = participantResult.rows[0].participant_id;
    const registrationIds = [];
    let totalAmount = 0;
    
    // Workshops (Day 1)
    for (const eventId of workshop_selections) {
      const available = await checkSeatAvailability(eventId, department);
      if (!available) {
        throw new Error(`No seats available for selected workshop`);
      }
      
      const event = await client.query(
        'SELECT event_name, fee FROM events WHERE event_id = $1',
        [eventId]
      );
      
      const baseRegId = await generateRegistrationID(participantId, true);
const regId = `${baseRegId}-${eventId}`;

      
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
        [participantId, eventId, regId, 'Pending', event.rows[0].fee, event.rows[0].event_name]
      );
      
      // ❌ SEAT DECREMENT REMOVED HERE (INTENTIONAL)
      
      registrationIds.push(regId);
      totalAmount += parseFloat(event.rows[0].fee || 0);
    }
    
    // Events (Day 2)
    for (const eventId of event_selections) {
      const event = await client.query(
        'SELECT event_name, fee FROM events WHERE event_id = $1',
        [eventId]
      );
      
     const baseRegId = await generateRegistrationID(participantId, false);
const regId = `${baseRegId}-${eventId}`;

      
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, 2)`,
        [participantId, eventId, regId, 'Pending', event.rows[0].fee, event.rows[0].event_name]
      );
      
      registrationIds.push(regId);
      totalAmount += parseFloat(event.rows[0].fee || 0);
    }
    
    const paymentReference = `THREADS26-${participantId}-${Date.now()}`;
    
    await client.query('COMMIT');
    
    const paymentOptions = {
      upi_id: process.env.UPI_ID || 'threads26@okaxis',
      bank_account: process.env.BANK_ACCOUNT || '1234567890',
      ifsc_code: process.env.BANK_IFSC || 'SBIN0001234',
      payment_reference: paymentReference,
      amount: totalAmount,
      payment_methods: ['UPI', 'Credit Card', 'Debit Card', 'Net Banking']
    };
    
    await sendEmail(
      email,
      "THREADS'26 - Registration & Payment Instructions",
      `<h1>Registration Received</h1>`
    );
    
    if (phone) {
      await sendWhatsApp(phone, `THREADS'26 registration received. Pay ₹${totalAmount}`);
    }
    
    return reply.code(201).send({
      success: true,
      participant_id: participantId,
      registration_ids: registrationIds,
      total_amount: totalAmount,
      payment_reference: paymentReference,
      payment_options: paymentOptions
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    return reply.code(400).send({ error: error.message });
  } finally {
    client.release();
  }
});

// 4. Payment Verification (CSV-based)
fastify.post('/api/verify-payment', async (request, reply) => {
  const client = await pool.connect();

  try {
    const {
      participant_id,
      transaction_id,
      payment_reference,
      payment_method = 'UPI'
    } = request.body;

    // Prevent duplicate transaction
    const dup = await client.query(
      'SELECT 1 FROM payments WHERE transaction_id = $1',
      [transaction_id]
    );
    if (dup.rows.length > 0) {
      throw new Error('Transaction already used');
    }

    // Pending amount
    const pending = await client.query(
      `SELECT SUM(amount_paid) AS total
       FROM registrations
       WHERE participant_id = $1 AND payment_status = 'Pending'`,
      [participant_id]
    );

    const amount = Number(pending.rows[0].total || 0);
    if (amount <= 0) {
      throw new Error('No pending registrations');
    }

    await client.query('BEGIN');

    // Save payment
    const paymentResult = await client.query(
      `INSERT INTO payments (
        participant_id, transaction_id, payment_reference,
        amount, payment_method, payment_status
      ) VALUES ($1,$2,$3,$4,$5,'Success')
      RETURNING payment_id, created_at`,
      [
        participant_id,
        transaction_id,
        payment_reference,
        amount,
        payment_method
      ]
    );

    // Get all pending registrations
    const regs = await client.query(
      `SELECT event_id, registration_unique_id
       FROM registrations
       WHERE participant_id = $1 AND payment_status = 'Pending'`,
      [participant_id]
    );

    // ✅ SEAT DECREASE HAPPENS HERE
    for (const r of regs.rows) {
      await updateSeats(r.event_id);
    }

    // Mark registrations as confirmed
    await client.query(
      `UPDATE registrations
       SET payment_status = 'Success'
       WHERE participant_id = $1`,
      [participant_id]
    );

    await client.query('COMMIT');

    // 🔲 ONE QR WITH ALL REGISTRATION IDS
    const registrationIds = regs.rows.map(r => r.registration_unique_id);

    const qrPayload = {
      participant_id,
      registration_ids: registrationIds,
      event: "THREADS'26"
    };

    const qrCodeBase64 = await QRCode.toDataURL(
      JSON.stringify(qrPayload)
    );

    return reply.send({
      success: true,
      payment_id: paymentResult.rows[0].payment_id,
      payment_date: paymentResult.rows[0].created_at,
      registration_ids: registrationIds,
      qr_code: qrCodeBase64,
      message: 'Payment verified & registration confirmed'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    return reply.code(400).send({ error: err.message });
  } finally {
    client.release();
  }
});
// 5. Admin CSV Upload for Bulk Verification
// -------------------- ADMIN PAYMENT VERIFICATION ENDPOINTS --------------------

// 1. Admin Login
fastify.post('/api/admin/login', async (request, reply) => {
  const { username, password } = request.body;
  
  // In production, use proper authentication with JWT
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'threads26';
  
  if (username === adminUsername && password === adminPassword) {
    const token = crypto.randomBytes(32).toString('hex');
    return { 
      success: true, 
      token: token,
      expires_in: '24h'
    };
  }
  
  return reply.code(401).send({ error: 'Invalid credentials' });
});

fastify.get('/api/admin/registrations', async (request) => {
  try {
    const { page = 1, limit = 50, event_id, payment_status } = request.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        r.registration_id,
        r.registration_unique_id,
        r.payment_status,
        r.registered_at,
        r.attendance_status,

        p.full_name,
        p.email,
        p.phone,
        p.college_name,
        p.department,

        e.event_name,
        e.event_type,
        e.day,

        py.transaction_id,
        py.payment_method,
        py.payment_status AS payment_verification_status,
        py.verified_by_admin,
        py.verified_at

      FROM registrations r
      JOIN participants p ON r.participant_id = p.participant_id
      JOIN events e ON r.event_id = e.event_id
      LEFT JOIN payments py 
        ON r.participant_id = py.participant_id
        AND py.created_at = (
          SELECT MAX(created_at)
          FROM payments
          WHERE participant_id = r.participant_id
        )
      WHERE 1=1
    `;

    const params = [];
    let i = 1;

    if (event_id) {
      query += ` AND e.event_id = $${i++}`;
      params.push(event_id);
    }

    if (payment_status) {
      query += ` AND r.payment_status = $${i++}`;
      params.push(payment_status);
    }

    query += ` ORDER BY r.registered_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // ✅ ADD verification fields WITHOUT breaking frontend
    const rows = result.rows.map(row => {
      let verification_status = 'NOT_VERIFIED';

      if (row.payment_verification_status === 'Success') {
        verification_status = row.verified_by_admin
          ? 'ADMIN_VERIFIED'
          : 'AUTO_VERIFIED';
      }

      return {
        ...row,
        verification_status,       // 🔥 NEW
        verified_by: row.verified_by_admin ? 'ADMIN' : 'SYSTEM'
      };
    });

    return rows;

  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});


// 3. Get Pending Payment Verifications
fastify.get('/api/admin/pending-verifications', async (request) => {
  // Verify admin token
  
  try {
    const { page = 1, limit = 50 } = request.query;
    const offset = (page - 1) * limit;
    
    const verifications = await pool.query(
      `SELECT pv.*, p.full_name, p.email, p.phone 
       FROM payment_verification pv
       JOIN participants p ON pv.participant_id = p.participant_id
       WHERE pv.verification_status = 'Pending'
       ORDER BY pv.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    const total = await pool.query(
      'SELECT COUNT(*) FROM payment_verification WHERE verification_status = $1',
      ['Pending']
    );
    
    return {
      verifications: verifications.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total.rows[0].count),
        pages: Math.ceil(total.rows[0].count / limit)
      }
    };
    
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 4. Manual Payment Verification (admin override)
fastify.post('/api/admin/manual-verification', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    const {
      participant_id,  // Add this
      transaction_id,
      amount,
      admin_token
    } = request.body;
    
    // Admin authentication
    if (!admin_token || admin_token !== process.env.ADMIN_TOKEN) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    
    await client.query('BEGIN');
    
    // Record payment directly
    const paymentResult = await client.query(
      `INSERT INTO payments (
        participant_id, transaction_id, amount,
        payment_method, payment_status, verified_at,
        verified_by_admin, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING payment_id`,
      [participant_id, transaction_id, amount,
       'Bank Transfer (Manual)', 'Success', new Date(),
       true, 'Manually verified by admin']
    );
    
    // Update registrations
    await client.query(
      `UPDATE registrations SET payment_status = 'Success'
       WHERE participant_id = $1 AND payment_status = 'Pending'`,
      [participant_id]
    );
    
    await client.query('COMMIT');
    
    return {
      success: true,
      message: 'Payment manually verified',
      payment_id: paymentResult.rows[0].payment_id,
      participant_id: participant_id,
      amount: amount
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    fastify.log.error(error);
    return reply.code(400).send({ error: error.message });
  } finally {
    client.release();
  }
});

// 5. Admin Upload CSV for Bulk Verification (You already have this)
// fastify.post('/api/admin/upload-transactions', ...)

// -------------------- ADMIN ATTENDANCE ENDPOINTS --------------------

// 6. Admin QR Scan & Attendance Update
fastify.post('/api/admin/scan-qr', async (request, reply) => {
  try {
    const { qr_data, admin_token } = request.body;
    
    // Verify admin
    if (!admin_token || admin_token !== process.env.ADMIN_TOKEN) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    
    // Parse QR data
    let participantData;
    try {
      participantData = JSON.parse(qr_data);
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid QR data format' });
    }
    
    // Verify hash
    const expectedHash = crypto.createHash('sha256')
      .update(participantData.participant_id + (process.env.QR_SECRET || 'threads26'))
      .digest('hex');
    
    if (participantData.verification_hash !== expectedHash) {
      return reply.code(400).send({ error: 'Invalid QR code' });
    }
    
    // Get participant details
    const participant = await pool.query(
      `SELECT * FROM participants WHERE participant_id = $1`,
      [participantData.participant_id]
    );
    
    if (participant.rows.length === 0) {
      throw new Error('Participant not found');
    }
    
    // Get registrations
    const registrations = await pool.query(
      `SELECT r.*, e.event_name, e.day FROM registrations r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1`,
      [participantData.participant_id]
    );
    
    return {
      success: true,
      participant: participant.rows[0],
      registrations: registrations.rows,
      scanned_at: new Date().toISOString()
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(400).send({ error: error.message });
  }
});

// 7. Update Attendance Status (QR Scan Based)
fastify.post('/api/admin/attendance', async (request, reply) => {
  const client = await pool.connect();

  try {
    const { registration_id } = request.body;

    if (!registration_id) {
      return reply.code(400).send({
        error: 'registration_id is required'
      });
    }

    await client.query('BEGIN');

    // Mark attendance using ONLY registration_unique_id
    const result = await client.query(
      `
      UPDATE registrations
      SET attendance_status = 'ATTENDED',
          attended_at = NOW()
      WHERE registration_unique_id = $1
        AND attendance_status != 'ATTENDED'
      RETURNING registration_unique_id, event_id, attendance_status
      `,
      [registration_id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({
        error: 'Invalid Registration ID or already attended'
      });
    }

    await client.query('COMMIT');

    return {
      success: true,
      message: 'Attendance marked successfully',
      registration_id: result.rows[0].registration_unique_id,
      event_id: result.rows[0].event_id,
      attendance_status: result.rows[0].attendance_status,
      attended_at: new Date().toISOString()
    };

  } catch (error) {
    await client.query('ROLLBACK');
    fastify.log.error(error);
    return reply.code(500).send({
      error: 'Failed to update attendance'
    });
  } finally {
    client.release();
  }
});


// 8. Get Attendance Report
fastify.get('/api/admin/attendance-report', async (request) => {
  // Verify admin token
  const adminToken = request.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    throw new Error('Unauthorized');
  }
  
  try {
    const { event_id, day, date } = request.query;
    
    let query = `
      SELECT 
        p.full_name,
        p.email,
        p.phone,
        p.college_name,
        p.department,
        r.registration_unique_id,
        r.attendance_status,
        r.attended_at,
        e.event_name,
        e.event_type,
        e.day
      FROM registrations r
      JOIN participants p ON r.participant_id = p.participant_id
      JOIN events e ON r.event_id = e.event_id
      WHERE r.payment_status = 'Success'
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (event_id) {
      query += ` AND e.event_id = $${paramCount++}`;
      params.push(event_id);
    }
    
    if (day) {
      query += ` AND e.day = $${paramCount++}`;
      params.push(day);
    }
    
    if (date) {
      query += ` AND DATE(r.registered_at) = $${paramCount++}`;
      params.push(date);
    }
    
    query += ` ORDER BY e.day, e.event_name, p.full_name`;
    
    const result = await pool.query(query, params);
    
    // Group by event and calculate stats
    const stats = {
      total: result.rowCount,
      attended: result.rows.filter(r => r.attendance_status === 'ATTENDED').length,
      not_attended: result.rows.filter(r => r.attendance_status === 'NOT_ATTENDED').length,
      by_event: {},
      by_day: {}
    };
    
    // Calculate by event
    result.rows.forEach(row => {
      if (!stats.by_event[row.event_name]) {
        stats.by_event[row.event_name] = {
          total: 0,
          attended: 0,
          not_attended: 0
        };
      }
      stats.by_event[row.event_name].total++;
      if (row.attendance_status === 'ATTENDED') {
        stats.by_event[row.event_name].attended++;
      } else {
        stats.by_event[row.event_name].not_attended++;
      }
    });
    
    // Calculate by day
    result.rows.forEach(row => {
      if (!stats.by_day[row.day]) {
        stats.by_day[row.day] = {
          total: 0,
          attended: 0,
          not_attended: 0
        };
      }
      stats.by_day[row.day].total++;
      if (row.attendance_status === 'ATTENDED') {
        stats.by_day[row.day].attended++;
      } else {
        stats.by_day[row.day].not_attended++;
      }
    });
    
    return {
      registrations: result.rows,
      statistics: stats
    };
    
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 9. Bulk Attendance Update
fastify.post('/api/admin/bulk-attendance', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    const { 
      participant_ids, 
      event_ids,
      attendance_status,
      admin_token 
    } = request.body;
    
    // Verify admin
    if (!admin_token || admin_token !== process.env.ADMIN_TOKEN) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    
    if (!['NOT_ATTENDED', 'ATTENDED'].includes(attendance_status)) {
      return reply.code(400).send({ error: 'Invalid attendance status' });
    }
    
    let query;
    let params;
    
    if (participant_ids && participant_ids.length > 0) {
      // Update all registrations for specific participants
      query = `
        UPDATE registrations 
        SET attendance_status = $1, attended_at = $2
        WHERE participant_id = ANY($3)
        RETURNING registration_unique_id, participant_id, attendance_status
      `;
      params = [attendance_status, new Date(), participant_ids];
    } else if (event_ids && event_ids.length > 0) {
      // Update all registrations for specific events
      query = `
        UPDATE registrations 
        SET attendance_status = $1, attended_at = $2
        WHERE event_id = ANY($3)
        RETURNING registration_unique_id, event_id, attendance_status
      `;
      params = [attendance_status, new Date(), event_ids];
    } else {
      return reply.code(400).send({ 
        error: 'Provide either participant_ids or event_ids' 
      });
    }
    
    const result = await client.query(query, params);
    
    await client.query('COMMIT');
    
    return {
      success: true,
      updated_count: result.rowCount,
      message: `Marked ${result.rowCount} registrations as ${attendance_status}`
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    fastify.log.error(error);
    return reply.code(400).send({ error: error.message });
  } finally {
    client.release();
  }
});

// 10. Export Registrations (Admin)
fastify.get('/api/admin/export', async (request, reply) => {
  // Verify admin token
  const adminToken = request.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  
  try {
    const result = await pool.query(`
      SELECT 
        p.full_name,
        p.email,
        p.phone,
        p.college_name,
        p.department,
        p.year_of_study,
        p.city,
        p.state,
        p.accommodation_required,
        r.registration_unique_id,
        r.payment_status,
        r.amount_paid,
        r.registered_at,
        r.attendance_status,
        e.event_name,
        e.event_type,
        e.day,
        e.fee
      FROM registrations r
      JOIN participants p ON r.participant_id = p.participant_id
      JOIN events e ON r.event_id = e.event_id
      ORDER BY r.registered_at DESC
    `);
    
    // Convert to CSV
    const headers = Object.keys(result.rows[0] || {}).join(',');
    const rows = result.rows.map(row => 
      Object.values(row).map(val => 
        typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val
      ).join(',')
    ).join('\n');
    
    const csv = `${headers}\n${rows}`;
    
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="registrations.csv"');
    return csv;
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Export failed' });
  }
});


// Add this endpoint after your existing endpoints:

// Check Payment Verification Status (for participants)
fastify.get('/api/participant/:id/verification-status', async (request, reply) => {
  try {
    const { id } = request.params;
    
    // Get participant details
    const participant = await pool.query(
      'SELECT * FROM participants WHERE participant_id = $1',
      [id]
    );
    
    if (participant.rows.length === 0) {
      return reply.code(404).send({ error: 'Participant not found' });
    }
    
    // Get payments
    const payments = await pool.query(
      `SELECT 
        payment_id,
        transaction_id,
        amount,
        payment_method,
        payment_status,
        verified_by_admin,
        verified_at,
        created_at,
        notes
       FROM payments 
       WHERE participant_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    
    // Get registrations
    const registrations = await pool.query(
      `SELECT 
        registration_unique_id,
        payment_status,
        amount_paid,
        registered_at
       FROM registrations 
       WHERE participant_id = $1`,
      [id]
    );
    
    // Calculate status
    const totalPending = registrations.rows.filter(r => r.payment_status === 'Pending').length;
    const totalPaid = registrations.rows.filter(r => r.payment_status === 'Success').length;
    
    let verificationStatus = 'NOT_VERIFIED';
    let verifiedBy = 'System';
    let verifiedAt = null;
    
    if (payments.rows.length > 0) {
      const latestPayment = payments.rows[0];
      
      if (latestPayment.verified_by_admin) {
        verificationStatus = 'ADMIN_VERIFIED';
        verifiedBy = 'Administrator';
        verifiedAt = latestPayment.verified_at;
      } else if (latestPayment.payment_status === 'Success') {
        verificationStatus = 'AUTO_VERIFIED';
        verifiedBy = 'System Auto-Verification';
        verifiedAt = latestPayment.created_at;
      }
    }
    
    return {
      participant_id: id,
      full_name: participant.rows[0].full_name,
      email: participant.rows[0].email,
      
      verification_status: verificationStatus,
      verified_by: verifiedBy,
      verified_at: verifiedAt,
      
      payment_summary: {
        total_registrations: registrations.rows.length,
        paid_registrations: totalPaid,
        pending_registrations: totalPending,
        total_amount: payments.rows.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0)
      },
      
      payments: payments.rows.map(p => ({
        payment_id: p.payment_id,
        transaction_id: p.transaction_id,
        amount: p.amount,
        method: p.payment_method,
        status: p.payment_status,
        verified_by_admin: p.verified_by_admin,
        verified_at: p.verified_at,
        notes: p.notes
      })),
      
      registrations: registrations.rows.map(r => ({
        registration_id: r.registration_unique_id,
        payment_status: r.payment_status,
        amount: r.amount_paid,
        registered_at: r.registered_at
      })),
      
      next_actions: {
        download_qr: totalPaid > 0 ? `/api/participant/${id}/qr` : null,
        download_certificate: totalPaid > 0 ? `/api/participant/${id}/certificate` : null,
        verify_payment: totalPending > 0 ? `${process.env.FRONTEND_URL}/verify-payment` : null,
        contact_admin: 'threads26@college.edu'
      }
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// 6. Track Registration (Frontend page) - UPDATED
fastify.get('/api/track/:registration_id', async (request, reply) => {
  try {
    const { registration_id } = request.params;
    
    const result = await pool.query(
      `SELECT 
        r.registration_unique_id,
        r.payment_status,
        r.registered_at,
        r.attendance_status,
        p.full_name,
        p.email,
        p.phone,
        p.college_name,
        p.department,
        e.event_name,
        e.event_type,
        e.day,
        e.fee,
        py.transaction_id,
        py.payment_method,
        py.payment_status as payment_verification_status,
        py.verified_by_admin,
        py.verified_at,
        py.created_at as payment_date
       FROM registrations r
       JOIN participants p ON r.participant_id = p.participant_id
       JOIN events e ON r.event_id = e.event_id
       LEFT JOIN payments py ON r.participant_id = py.participant_id
       WHERE r.registration_unique_id = $1
       ORDER BY py.created_at DESC LIMIT 1`,
      [registration_id]
    );
    
    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Registration not found' });
    }
    
    const row = result.rows[0];
    
    // Determine verification status
    let verification_status = 'NOT_VERIFIED';
    let verified_by = null;
    
    if (row.payment_verification_status === 'Success') {
      if (row.verified_by_admin) {
        verification_status = 'ADMIN_VERIFIED';
        verified_by = 'Administrator';
      } else {
        verification_status = 'AUTO_VERIFIED';
        verified_by = 'System';
      }
    }
    
    return {
      registration: {
        registration_id: row.registration_unique_id,
        payment_status: row.payment_status,
        registered_at: row.registered_at,
        attendance_status: row.attendance_status,
        event_name: row.event_name,
        event_type: row.event_type,
        day: row.day,
        fee: row.fee
      },
      
      participant: {
        full_name: row.full_name,
        email: row.email,
        phone: row.phone,
        college_name: row.college_name,
        department: row.department
      },
      
      payment: {
        transaction_id: row.transaction_id,
        payment_method: row.payment_method,
        payment_status: row.payment_verification_status,
        verification_status: verification_status,
        verified_by: verified_by,
        verified_at: row.verified_at,
        payment_date: row.payment_date
      },
      
      actions: {
        download_qr: row.payment_status === 'Success' 
          ? `/api/participant/qr/${row.registration_unique_id}`
          : null,
        download_certificate: row.payment_status === 'Success' 
          ? `/api/participant/certificate/${row.participant_id}`
          : null,
        check_verification: `/api/participant/${row.participant_id}/verification-status`,
        verify_payment: row.payment_status === 'Pending'
          ? `${process.env.FRONTEND_URL}/verify-payment`
          : null
      }
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// 11. Get Statistics (Admin)
fastify.get('/api/admin/stats', async (request) => {
  
  try {
    const stats = await Promise.all([
      // Total registrations
      pool.query('SELECT COUNT(*) FROM registrations'),
      
      // Total participants
      pool.query('SELECT COUNT(DISTINCT participant_id) FROM registrations'),
      
      // Total revenue
      pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments 
                  WHERE payment_status = 'Success'`),
      
      // Registrations by day
      pool.query(`
        SELECT e.day, COUNT(*) as count 
        FROM registrations r
        JOIN events e ON r.event_id = e.event_id
        GROUP BY e.day
      `),
      
      // Top events
      pool.query(`
        SELECT e.event_name, COUNT(*) as registrations
        FROM registrations r
        JOIN events e ON r.event_id = e.event_id
        GROUP BY e.event_name
        ORDER BY COUNT(*) DESC
        LIMIT 5
      `),
      
      // College distribution
      pool.query(`
        SELECT college_name, COUNT(DISTINCT participant_id) as participants
        FROM participants
        WHERE college_name IS NOT NULL
        GROUP BY college_name
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `),
      
      // Payment status
      pool.query(`
        SELECT payment_status, COUNT(*) as count
        FROM registrations
        GROUP BY payment_status
      `),
      
      // Attendance status
      pool.query(`
        SELECT attendance_status, COUNT(*) as count
        FROM registrations
        WHERE payment_status = 'Success'
        GROUP BY attendance_status
      `)
    ]);
    
    return {
      total_registrations: parseInt(stats[0].rows[0].count),
      total_participants: parseInt(stats[1].rows[0].count),
      total_revenue: parseFloat(stats[2].rows[0].total),
      registrations_by_day: stats[3].rows,
      top_events: stats[4].rows,
      top_colleges: stats[5].rows,
      payment_status: stats[6].rows,
      attendance_status: stats[7].rows,
      updated_at: new Date().toISOString()
    };
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 12. Update Event Status (Admin)
fastify.patch('/api/admin/events/:id', async (request, reply) => {
  const adminToken = request.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  
  try {
    const { id } = request.params;
    const { is_active, total_seats, cse_seats } = request.body;
    
    const updates = [];
    const params = [];
    let paramCount = 1;
    
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      params.push(is_active);
    }
    
    if (total_seats !== undefined) {
      updates.push(`total_seats = $${paramCount++}, available_seats = $${paramCount++}`);
      params.push(total_seats, total_seats);
    }
    
    if (cse_seats !== undefined) {
      updates.push(`cse_seats = $${paramCount++}, cse_available_seats = $${paramCount++}`);
      params.push(cse_seats, cse_seats);
    }
    
    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No updates provided' });
    }
    
    params.push(id);
    
    const query = `
      UPDATE events 
      SET ${updates.join(', ')} 
      WHERE event_id = $${paramCount}
      RETURNING *
    `;
    
    const result = await pool.query(query, params);
    
    return { 
      success: true, 
      event: result.rows[0] 
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(400).send({ error: error.message });
  }
});

// 13. Upload Gallery Image (Admin)
fastify.post('/api/admin/gallery', async (request, reply) => {
  // Verify admin token
  const adminToken = request.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  
  try {
    const data = await request.file();
    const { album_name } = data.fields;
    
    // Save file (in production, upload to S3/Cloudinary)
    const fileName = `${uuidv4()}${path.extname(data.filename)}`;
    const uploadPath = path.join(__dirname, 'public', 'uploads', fileName);
    
    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(uploadPath), { recursive: true });
    
    const writeStream = fs.createWriteStream(uploadPath);
    await data.file.pipe(writeStream);
    
    // Save to database
    const imageUrl = `/public/uploads/${fileName}`;
    const result = await pool.query(
      `INSERT INTO gallery (album_name, image_url) 
       VALUES ($1, $2) 
       RETURNING image_id`,
      [album_name.value, imageUrl]
    );
    
    return { 
      success: true, 
      image_id: result.rows[0].image_id,
      image_url: imageUrl
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Upload failed' });
  }
});

// 14. Get Gallery Images (Public)
fastify.get('/api/gallery', async (request) => {
  try {
    const { album_name } = request.query;
    let query = 'SELECT * FROM gallery ORDER BY uploaded_at DESC';
    const params = [];
    
    if (album_name) {
      query = 'SELECT * FROM gallery WHERE album_name = $1 ORDER BY uploaded_at DESC';
      params.push(album_name);
    }
    
    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 15. Create announcement (Admin)
fastify.post('/api/admin/announcements', async (request, reply) => {
  const adminToken = request.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  
  try {
    const { title, content, expires_at } = request.body;
    
    const result = await pool.query(
      `INSERT INTO announcements (title, content, expires_at)
       VALUES ($1, $2, $3)
       RETURNING announcement_id, created_at`,
      [title, content, expires_at]
    );
    
    return {
      success: true,
      announcement_id: result.rows[0].announcement_id,
      created_at: result.rows[0].created_at
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(400).send({ error: error.message });
  }
});

// 16. Get active announcements (Public)
fastify.get('/api/announcements', async () => {
  try {
    const result = await pool.query(
      `SELECT * FROM announcements 
       WHERE is_active = true AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`
    );
    return result.rows;
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 17. Get QR for participant (for admin display)
fastify.get('/api/participant/:id/qr-data', async (request) => {
  try {
    const { id } = request.params;
    
    const participant = await pool.query(
      `SELECT * FROM participants WHERE participant_id = $1`,
      [id]
    );
    
    if (participant.rows.length === 0) {
      throw new Error('Participant not found');
    }
    
    const registrations = await pool.query(
      `SELECT 
        r.registration_unique_id,
        r.payment_status,
        r.amount_paid,
        r.registered_at,
        r.attendance_status,
        e.event_name,
        e.event_type,
        e.day,
        e.fee
       FROM registrations r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1`,
      [id]
    );
    
    const payments = await pool.query(
      `SELECT * FROM payments 
       WHERE participant_id = $1 AND payment_status = 'Success'`,
      [id]
    );
    
    const totalAmount = registrations.rows.reduce((sum, reg) => 
      sum + parseFloat(reg.amount_paid || 0), 0
    );
    
    return {
      participant: participant.rows[0],
      registrations: registrations.rows,
      payments: payments.rows,
      total_amount: totalAmount,
      qr_url: `/api/participant/${id}/qr`
    };
    
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});



// 7. Download Confirmation PDF
fastify.get('/api/participant/:id/certificate', async (request, reply) => {
  try {
    const { id } = request.params;
    
    // Check if paid
    const paid = await pool.query(
      `SELECT COUNT(*) FROM registrations 
       WHERE participant_id = $1 AND payment_status = 'Success'`,
      [id]
    );
    
    if (parseInt(paid.rows[0].count) === 0) {
      return reply.code(400).send({ error: 'No paid registrations found' });
    }
    
    const pdfPath = path.join(__dirname, 'public', 'certificates', `confirmation_${id}.pdf`);

    
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="THREADS26_Confirmation_${id}.pdf"`);
    
    return fs.createReadStream(pdfPath);
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// 8. Contact Information
fastify.get('/api/contact', async () => {
  return {
    college_name: 'Your College Name',
    department: 'Computer Science and Engineering',
    address: 'College Address, City, State, Pincode',
    email: 'threads26@college.edu',
    
    student_coordinators: [
      { name: 'Student 1', phone: '9876543210', role: 'Technical Head' },
      { name: 'Student 2', phone: '9876543211', role: 'Event Head' }
    ],
    
    faculty_coordinators: [
      { name: 'Dr. Faculty 1', phone: '9876543212', role: 'HOD, CSE' },
      { name: 'Dr. Faculty 2', phone: '9876543213', role: 'Symposium Coordinator' }
    ],
    
    google_maps_url: 'https://maps.google.com/?q=College+Address'
  };
});

// 9. Auto-close Registration Check (Cron job simulation)
fastify.get('/api/admin/check-registration-status', async (request) => {
  const today = moment();
  const closeDate = moment(EVENT_DATES.registration_closes);
  
  if (today.isAfter(closeDate)) {
    // Close all events
    await pool.query(
      `UPDATE events SET is_active = false WHERE is_active = true`
    );
    
    return {
      status: 'closed',
      message: 'Registration automatically closed as per event date',
      closed_at: new Date().toISOString()
    };
  }
  
  return {
    status: 'open',
    days_remaining: closeDate.diff(today, 'days'),
    closes_on: EVENT_DATES.registration_closes
  };
});

// -------------------- Database Setup with All Fields --------------------
fastify.get('/api/setup-db', async (request, reply) => {
  try {
    const queries = [
      // Participants table
      `CREATE TABLE IF NOT EXISTS participants (
        participant_id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20) NOT NULL,
        college_name VARCHAR(255) NOT NULL,
        department VARCHAR(100) NOT NULL,
        year_of_study INTEGER NOT NULL,
        city VARCHAR(100),
        state VARCHAR(100),
        accommodation_required BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Events table (with ALL required fields)
      `CREATE TABLE IF NOT EXISTS events (
        event_id SERIAL PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        event_type VARCHAR(50) NOT NULL CHECK (event_type IN ('workshop', 'technical', 'non-technical')),
        day INTEGER NOT NULL CHECK (day IN (1, 2)),
        fee DECIMAL(10, 2) DEFAULT 0,
        description TEXT,
        duration VARCHAR(50),
        speaker VARCHAR(255),
        rules TEXT,
        total_seats INTEGER DEFAULT 100,
        available_seats INTEGER DEFAULT 100,
        cse_seats INTEGER DEFAULT 30,
        cse_available_seats INTEGER DEFAULT 30,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Registrations table
      `CREATE TABLE IF NOT EXISTS registrations (
        registration_id SERIAL PRIMARY KEY,
        participant_id INTEGER REFERENCES participants(participant_id),
        event_id INTEGER REFERENCES events(event_id),
        registration_unique_id VARCHAR(50) UNIQUE NOT NULL,
        payment_status VARCHAR(20) DEFAULT 'Pending' CHECK (payment_status IN ('Pending', 'Success', 'Failed', 'Refunded')),
        amount_paid DECIMAL(10, 2) DEFAULT 0,
        event_name VARCHAR(255),
        day INTEGER,
        attendance_status VARCHAR(20) DEFAULT 'NOT_ATTENDED' CHECK (attendance_status IN ('NOT_ATTENDED', 'ATTENDED')),
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        attended_at TIMESTAMP,
        certificate_generated BOOLEAN DEFAULT false
      )`,
      
      // Payments table
      `CREATE TABLE IF NOT EXISTS payments (
        payment_id SERIAL PRIMARY KEY,
        participant_id INTEGER REFERENCES participants(participant_id),
        transaction_id VARCHAR(100),
        payment_reference VARCHAR(100),
        amount DECIMAL(10, 2) NOT NULL,
        payment_method VARCHAR(50),
        payment_status VARCHAR(20) DEFAULT 'Success' CHECK (payment_status IN ('Success', 'Failed', 'Refunded')),
        verified_by_admin BOOLEAN DEFAULT false,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        verified_at TIMESTAMP
      )`,
      
      // Gallery table
      `CREATE TABLE IF NOT EXISTS gallery (
        image_id SERIAL PRIMARY KEY,
        album_name VARCHAR(100) NOT NULL,
        image_url VARCHAR(500) NOT NULL,
        caption TEXT,
        uploaded_by VARCHAR(100),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Announcements table
      `CREATE TABLE IF NOT EXISTS announcements (
        announcement_id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      )`
    ];
    
    for (const query of queries) {
      await pool.query(query);
    }
    
    // Insert sample events
    const sampleEvents = [
      // Workshops (Day 1)
      [1, 'AI/ML Workshop', 'workshop', 1, 150, 'Learn AI/ML techniques', '3 hours', 'Dr. AI Expert', 'Bring laptop with Python', 50, 50, 30, 30, true],
      [2, 'Web3 Workshop', 'workshop', 1, 120, 'Blockchain and Web3', '3 hours', 'Blockchain Specialist', 'Basic programming required', 50, 50, 30, 30, true],
      [3, 'IoT Workshop', 'workshop', 1, 130, 'Internet of Things', '3 hours', 'IoT Engineer', 'No prior experience', 50, 50, 30, 30, true],
      
      // Technical Events (Day 2)
      [4, 'Paper Presentation', 'technical', 2, 80, 'Present research papers', '2 hours', null, 'Max 2 authors per paper', 100, 100, 40, 40, true],
      [5, 'Code Relay', 'technical', 2, 70, 'Team coding competition', '2 hours', null, 'Teams of 2 members', 100, 100, 40, 40, true],
      [6, 'Debugging Challenge', 'technical', 2, 60, 'Find and fix bugs', '1.5 hours', null, 'Individual participation', 100, 100, 40, 40, true],
      
      // Non-Technical Events (Day 2)
      [7, 'Technical Quiz', 'non-technical', 2, 50, 'Tech knowledge quiz', '1 hour', null, 'Teams of 2-3 members', 100, 100, 40, 40, true],
      [8, 'Treasure Hunt', 'non-technical', 2, 40, 'Campus treasure hunt', '2 hours', null, 'Teams of 3-4 members', 100, 100, 40, 40, true],
      [9, 'Connections', 'non-technical', 2, 30, 'Word connection game', '1 hour', null, 'Individual participation', 100, 100, 40, 40, true]
    ];
    
    for (const event of sampleEvents) {
      await pool.query(`
        INSERT INTO events (
          event_id, event_name, event_type, day, fee, description,
          duration, speaker, rules, total_seats, available_seats,
          cse_seats, cse_available_seats, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (event_id) DO UPDATE SET
          event_name = EXCLUDED.event_name,
          event_type = EXCLUDED.event_type,
          fee = EXCLUDED.fee,
          description = EXCLUDED.description,
          duration = EXCLUDED.duration,
          speaker = EXCLUDED.speaker,
          rules = EXCLUDED.rules
      `, event);
    }
    
    return { 
      success: true, 
      message: 'Database setup complete with all required fields',
      tables_created: queries.length,
      sample_events_inserted: sampleEvents.length
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    await fastify.listen({
      port: PORT,
      host: '0.0.0.0' // REQUIRED for deployment
    });

    console.log(`🚀 Server running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
