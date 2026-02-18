import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import pg from 'pg';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';
import QRCode from 'qrcode';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
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
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
    max: 12,
});




const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Test Redis connection on startup
redis.ping().then(() => {
  console.log('✅ Redis connected successfully');
}).catch(err => {
  console.error('❌ Redis connection failed:', err.message);
});




const EVENT_DATES = {
  registration_closes: moment('2026-03-04', 'YYYY-MM-DD').format('YYYY-MM-DD'),
  workshop_day: moment('2026-03-05', 'YYYY-MM-DD').format('YYYY-MM-DD'),
  event_day: moment('2026-03-06', 'YYYY-MM-DD').format('YYYY-MM-DD')
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


fastify.get('/api/events', async (request, reply) => {
  try {
    const { day, type } = request.query;

    // Base query
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
    reply.status(500).send({ error: 'Failed to fetch events' });
  }
});

fastify.post('/api/register', async (request, reply) => {
  let client = null;
  
  try {
    // ===========================================
    // PHASE 1: FAST VALIDATION (No DB)
    // ===========================================
    const body = request.body;
    
    // Quick validation with early returns
    if (!body.full_name?.trim()) throw new Error('VALIDATION_FAILED: Full name is required');
    if (!body.email?.trim()) throw new Error('VALIDATION_FAILED: Email is required');
    if (!body.email.includes('@')) throw new Error('VALIDATION_FAILED: Invalid email format');
    
    const cleanPhone = body.phone?.replace(/\D/g, '') || '';
    if (cleanPhone.length < 10) throw new Error('VALIDATION_FAILED: Valid phone required');
    
    if (!body.college_name?.trim()) throw new Error('VALIDATION_FAILED: College name required');
    
    const dept = body.department?.toUpperCase() || '';
    if (!['CSE','IT','ECE','EEE','MECH','OTH'].includes(dept)) {
      throw new Error('VALIDATION_FAILED: Invalid department');
    }
    
    const year = parseInt(body.year_of_study);
    if (![1,2,3,4].includes(year)) throw new Error('VALIDATION_FAILED: Year must be 1-4');
    
    // Check selections
    const workshopSelections = body.workshop_selections || [];
    const eventSelections = body.event_selections || [];
    if (workshopSelections.length === 0 && eventSelections.length === 0) {
      throw new Error('NO_EVENTS_SELECTED: Select at least one event');
    }
    
    // Check deadline
    if (moment().isAfter(moment(EVENT_DATES.registration_closes))) {
      throw new Error('REGISTRATION_CLOSED');
    }
    
    // ===========================================
    // PHASE 2: CONNECT & EXECUTE (Optimized)
    // ===========================================
    client = await pool.connect();
    await client.query('BEGIN');
    
    // Check duplicate email (single query)
    const existing = await client.query(
      'SELECT 1 FROM participants WHERE LOWER(email)=LOWER($1)',
      [body.email]
    );
    if (existing.rows.length > 0) throw new Error('EMAIL_EXISTS');
    
    // Insert participant (faster with fewer fields)
    const participant = await client.query(
      `INSERT INTO participants (full_name, email, phone, college_name, department, year_of_study, gender, city, state, accommodation_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING participant_id`,
      [
        body.full_name.trim(),
        body.email.toLowerCase().trim(),
        cleanPhone,
        body.college_name.trim(),
        dept,
        year,
        body.gender || 'Not Specified',
        body.city?.trim() || '',
        body.state?.trim() || '',
        Boolean(body.accommodation_required)
      ]
    );
    
    const participantId = participant.rows[0].participant_id;
    const registrationIds = [];
    let totalAmount = 0; // ✅ FIXED: Initialize as number, not string
    
    // OPTIMIZED: Single query to get all event details
    const allEventIds = [...workshopSelections, ...eventSelections].map(id => parseInt(id));
    const eventDetails = await client.query(
      `SELECT event_id, event_name, fee, day, event_type, available_seats 
       FROM events WHERE event_id = ANY($1::int[]) AND is_active = true`,
      [allEventIds]
    );
    
    // Create map for O(1) lookup
    const eventMap = new Map();
    eventDetails.rows.forEach(e => eventMap.set(e.event_id, e));
    
    // Process workshops
    for (const eventId of workshopSelections) {
      const e = eventMap.get(parseInt(eventId));
      if (!e) throw new Error(`WORKSHOP_NOT_FOUND: ${eventId}`);
      if (e.event_type !== 'workshop') throw new Error(`NOT_A_WORKSHOP: ${eventId}`);
      if (e.available_seats <= 0) throw new Error(`SEATS_FULL: ${e.event_name}`);
      
      const regId = `THREADS26-WS-${Date.now()}-${eventId}`;
      const fee = parseFloat(e.fee) || 0; // ✅ Ensure number
      
      await client.query(
        `INSERT INTO registrations (participant_id, event_id, registration_unique_id, payment_status, amount_paid, event_name, day)
         VALUES ($1,$2,$3,'Pending',$4,$5,$6)`,
        [participantId, eventId, regId, fee, e.event_name, e.day]
      );
      
      registrationIds.push(regId);
      totalAmount += fee; // ✅ Number addition
    }
    
    // Process events
    for (const eventId of eventSelections) {
      const e = eventMap.get(parseInt(eventId));
      if (!e) throw new Error(`EVENT_NOT_FOUND: ${eventId}`);
      if (e.day !== 2) throw new Error(`NOT_DAY2_EVENT: ${eventId}`);
      if (e.available_seats <= 0) throw new Error(`SEATS_FULL: ${e.event_name}`);
      
      const regId = `THREADS26-EV-${Date.now()}-${eventId}`;
      const fee = parseFloat(e.fee) || 0; // ✅ Ensure number
      
      await client.query(
        `INSERT INTO registrations (participant_id, event_id, registration_unique_id, payment_status, amount_paid, event_name, day)
         VALUES ($1,$2,$3,'Pending',$4,$5,$6)`,
        [participantId, eventId, regId, fee, e.event_name, e.day]
      );
      
      registrationIds.push(regId);
      totalAmount += fee; // ✅ Number addition
    }
    
    await client.query('COMMIT');
    
    // Format amount to 2 decimal places
    const formattedAmount = parseFloat(totalAmount.toFixed(2));
    
    // Fast response
    return reply.code(201).send({
      success: true,
      message: 'Registration successful!',
      participant_id: participantId,
      participant_name: body.full_name,
      registration_ids: registrationIds,
      workshops_registered: workshopSelections.length,
      events_registered: eventSelections.length,
      total_amount: formattedAmount, // ✅ Fixed: Now shows correct number like 400.00
      payment_reference: `THREADS26-${participantId}-${Date.now().toString().slice(-6)}`,
      seat_status: { message: 'Seats checked - pay to reserve' },
      payment_options: {
        upi_id: process.env.UPI_ID || 'threads26@okaxis',
        amount: formattedAmount
      }
    });
    
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    
    const msg = error.message;
    if (msg.includes('SEATS_FULL')) return reply.code(400).send({ success: false, error: 'SEATS_FULL', details: msg });
    if (msg.includes('VALIDATION_FAILED')) return reply.code(400).send({ success: false, error: 'VALIDATION_FAILED', details: msg });
    if (msg.includes('EMAIL_EXISTS')) return reply.code(400).send({ success: false, error: 'EMAIL_EXISTS' });
    
    return reply.code(400).send({ success: false, error: 'REGISTRATION_ERROR', details: msg });
  } finally {
    if (client) client.release();
  }
});

fastify.post('/api/verify-payment', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    // ===========================================
    // PHASE 1: FAST VALIDATION
    // ===========================================
    const { participant_id, transaction_id, payment_reference, payment_method = 'UPI' } = request.body;
    
    if (!participant_id) throw new Error('PARTICIPANT_ID_REQUIRED');
    if (!transaction_id?.trim()) throw new Error('TRANSACTION_ID_REQUIRED');
    if (transaction_id.length < 5) throw new Error('TRANSACTION_ID_INVALID');
    
    const participantId = parseInt(participant_id);
    const cleanTransactionId = transaction_id.trim();
    
    // ===========================================
    // PHASE 2: PARALLEL QUERIES WHERE POSSIBLE
    // ===========================================
    await client.query('BEGIN');
    
    // Run checks in parallel
    const [duplicateCheck, participantCheck] = await Promise.all([
      client.query('SELECT 1 FROM payments WHERE transaction_id = $1', [cleanTransactionId]),
      client.query('SELECT participant_id, full_name FROM participants WHERE participant_id = $1', [participantId])
    ]);
    
    if (duplicateCheck.rows.length > 0) throw new Error('DUPLICATE_TRANSACTION');
    if (participantCheck.rows.length === 0) throw new Error('PARTICIPANT_NOT_FOUND');
    
    const participant = participantCheck.rows[0];
    
    // Get pending registrations with seat info in one query
    const pending = await client.query(
      `SELECT r.registration_id, r.event_id, r.registration_unique_id, r.amount_paid, r.event_name,
              e.available_seats, e.event_type, e.day
       FROM registrations r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1 AND r.payment_status = 'Pending'`,
      [participantId]
    );
    
    if (pending.rows.length === 0) throw new Error('NO_PENDING_REGISTRATIONS');
    
    // Calculate total (faster with reduce)
    const totalAmount = pending.rows.reduce((sum, r) => sum + parseFloat(r.amount_paid || 0), 0);
    if (totalAmount <= 0) throw new Error('INVALID_AMOUNT');
    
    // Check seats availability (fast loop with early exit)
    for (const reg of pending.rows) {
      if (reg.available_seats <= 0) {
        throw new Error(`SEATS_FULL_AT_PAYMENT: No seats for ${reg.event_name}`);
      }
    }
    
    // ===========================================
    // PHASE 3: BATCH UPDATES
    // ===========================================
    
    // Save payment
    const payment = await client.query(
      `INSERT INTO payments (participant_id, transaction_id, payment_reference, amount, payment_method, payment_status, verified_by_admin, verified_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'Success',false,NOW(),NOW()) RETURNING payment_id, created_at`,
      [
        participantId,
        cleanTransactionId,
        payment_reference?.trim() || `PAY-${Date.now().toString().slice(-8)}`,
        totalAmount,
        payment_method
      ]
    );
    
    // Update seats (batch update)
    const eventIds = pending.rows.map(r => r.event_id);
    await client.query(
      `UPDATE events SET available_seats = available_seats - 1
       WHERE event_id = ANY($1::int[])`,
      [eventIds]
    );
    
    // Mark registrations as confirmed
    await client.query(
      `UPDATE registrations SET payment_status = 'Success'
       WHERE participant_id = $1 AND payment_status = 'Pending'`,
      [participantId]
    );
    
    await client.query('COMMIT');
    
    // Get all registration IDs (single query)
    const allRegs = await client.query(
      `SELECT registration_unique_id FROM registrations 
       WHERE participant_id = $1 AND payment_status = 'Success'
       ORDER BY registered_at`,
      [participantId]
    );
    
    const registrationIds = allRegs.rows.map(r => r.registration_unique_id);
    
    // Generate QR (fast, no await needed for response)
    let qrCode = null;
    try {
      const qrPayload = { pid: participantId, ids: registrationIds.join('|') };
      qrCode = await QRCode.toDataURL(JSON.stringify(qrPayload), {
        errorCorrectionLevel: 'L', margin: 0, width: 200
      });
    } catch (e) {}
    
    // Fast response
    return reply.send({
      success: true,
      message: '✅ Payment verified!',
      payment_details: {
        participant_id: participantId,
        participant_name: participant.full_name,
        transaction_id: cleanTransactionId,
        amount: totalAmount,
        payment_id: payment.rows[0].payment_id,
        payment_date: payment.rows[0].created_at
      },
      seat_status: {
        message: '✅ Seats reserved',
        seats_reserved: pending.rows.length
      },
      registration_details: {
        total_registrations: registrationIds.length,
        registration_ids: registrationIds,
        events_registered: pending.rows.map(r => ({
          event_name: r.event_name,
          registration_id: r.registration_unique_id,
          amount: r.amount_paid
        }))
      },
      qr_code: qrCode,
      qr_payload: { pid: participantId, ids: registrationIds.join('|') }
    });
    
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    
    const msg = error.message;
    if (msg.includes('SEATS_FULL_AT_PAYMENT')) {
      return reply.code(400).send({ success: false, error: 'SEATS_FULL', details: msg });
    }
    if (msg.includes('DUPLICATE_TRANSACTION')) {
      return reply.code(400).send({ success: false, error: 'DUPLICATE_TRANSACTION' });
    }
    
    return reply.code(400).send({ 
      success: false, 
      error: 'PAYMENT_FAILED', 
      details: msg 
    });
    
  } finally {
    client.release();
  }
});

fastify.post("/api/admin/verify-payments", async (request, reply) => {
  const client = await pool.connect();

  try {
    const { payments: csvPayments } = request.body;

    if (!Array.isArray(csvPayments) || csvPayments.length === 0) {
      return reply.code(400).send({ error: "payments array required" });
    }

    await client.query("BEGIN");

    // 1. Get ALL previously verified payments
    const allVerifiedQuery = await client.query(
      `SELECT transaction_id
       FROM payments
       WHERE verified_by_admin = true
       AND payment_status = 'Success'
       ORDER BY verified_at DESC`
    );

    // 2. Get pending payments only
    const pendingPayments = await client.query(
      `SELECT
        p.payment_id,
        p.participant_id,
        p.transaction_id,
        p.amount,
        pt.full_name,
        pt.phone
       FROM payments p
       JOIN participants pt ON p.participant_id = pt.participant_id
       WHERE p.verified_by_admin = false
       AND p.payment_status = 'Success'
       AND NOT EXISTS (
         SELECT 1 FROM payments p2
         WHERE p2.participant_id = p.participant_id
         AND p2.verified_by_admin = true
         AND p2.payment_status = 'Success'
       )`
    );

    const newlyVerified = [];
    const failed = [];
    const paymentIdsToVerify = [];
    const participantIdsToUpdate = [];

    // 3. Process pending payments
    for (const dbPayment of pendingPayments.rows) {
      let matchedCsv = null;

      for (const csv of csvPayments) {
        if (!csv.transaction_id || csv.amount == null) continue;

        const cleanCsvId = String(csv.transaction_id).trim();
        const cleanDbId = String(dbPayment.transaction_id).trim();
        const csvAmount = parseFloat(csv.amount);
        const dbAmount = parseFloat(dbPayment.amount);

        if (cleanCsvId === cleanDbId) {
          matchedCsv = { csvAmount, dbAmount };
          break;
        }
      }

      // ✅ TRANSACTION + AMOUNT MATCH
      if (matchedCsv && Math.abs(matchedCsv.csvAmount - matchedCsv.dbAmount) < 0.01) {
        paymentIdsToVerify.push(dbPayment.payment_id);
        participantIdsToUpdate.push(dbPayment.participant_id);
        newlyVerified.push(dbPayment.transaction_id);
        continue;
      }

      // ❌ FAILURE CASE — find exact reason
      let reason = "TRANSACTION_NOT_FOUND";
      let receivedAmount = null;

      if (matchedCsv) {
        reason = "AMOUNT_MISMATCH";
        receivedAmount = matchedCsv.csvAmount;
      }

      // Check if participant already verified
      const participantHasVerified = await client.query(
        `SELECT 1 FROM payments
         WHERE participant_id = $1
         AND verified_by_admin = true
         AND payment_status = 'Success'`,
        [dbPayment.participant_id]
      );

      if (participantHasVerified.rowCount === 0) {
        failed.push({
          transaction_id: dbPayment.transaction_id,
          participant_id: dbPayment.participant_id,
          name: dbPayment.full_name,
          phone: dbPayment.phone,
          reason,
          expected_amount: parseFloat(dbPayment.amount),
          received_amount: receivedAmount
        });
      }
    }

    // 4. Batch updates
    if (paymentIdsToVerify.length > 0) {
      await client.query(
        `UPDATE payments
         SET verified_by_admin = true,
             verified_at = NOW()
         WHERE payment_id = ANY($1)`,
        [paymentIdsToVerify]
      );

      const uniqueParticipantIds = [...new Set(participantIdsToUpdate)];

      if (uniqueParticipantIds.length > 0) {
        await client.query(
          `UPDATE registrations
           SET payment_status = 'Success'
           WHERE participant_id = ANY($1)`,
          [uniqueParticipantIds]
        );
      }
    }

    await client.query("COMMIT");

    // 5. Final response
    const allVerified = [
      ...allVerifiedQuery.rows.map(r => r.transaction_id),
      ...newlyVerified
    ];

    const uniqueVerified = [...new Set(allVerified)];

    return {
      success: true,
      summary: {
        total_pending_before: pendingPayments.rowCount,
        csv_uploaded: csvPayments.length,
        newly_verified: newlyVerified.length,
        failed: failed.length,
        total_verified_now: uniqueVerified.length,
        previously_verified: allVerifiedQuery.rowCount
      },
      verified: uniqueVerified,
      failed
    };

  } catch (err) {
    await client.query("ROLLBACK");
    fastify.log.error(err);
    return reply.code(500).send({ error: "Verification failed" });
  } finally {
    client.release();
  }
});

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

    // ✅ OPTIMIZED QUERY - Use CTE for payments subquery
    let query = `
      WITH latest_payments AS (
        SELECT 
          participant_id,
          transaction_id,
          payment_method,
          payment_status as payment_verification_status,
          verified_by_admin,
          verified_at,
          ROW_NUMBER() OVER (PARTITION BY participant_id ORDER BY created_at DESC) as rn
        FROM payments
      )
      SELECT 
        r.participant_id,
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
        p.gender,

        e.event_name,
        e.event_type,
        e.day,
        

        lp.transaction_id,
        lp.payment_method,
        lp.payment_verification_status,
        lp.verified_by_admin,
        lp.verified_at

      FROM registrations r
      JOIN participants p ON r.participant_id = p.participant_id
      JOIN events e ON r.event_id = e.event_id
      LEFT JOIN latest_payments lp 
        ON r.participant_id = lp.participant_id 
        AND lp.rn = 1
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

    const rows = result.rows.map(row => {
      let verification_status = 'NOT_VERIFIED';

      if (row.payment_verification_status === 'Success') {
        verification_status = row.verified_by_admin
          ? 'ADMIN_VERIFIED'
          : 'AUTO_VERIFIED';
      }

      return {
        ...row,
        verification_status,
        verified_by: row.verified_by_admin ? 'ADMIN' : 'SYSTEM'
      };
    });

    return rows;

  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// Manual Payment Verification (schema-safe)
fastify.post('/api/admin/manual-verification', async (request, reply) => {
  const client = await pool.connect();

  try {
    const { participant_id } = request.body;

    if (!participant_id) {
      return reply.code(400).send({ error: 'participant_id is required' });
    }

    await client.query('BEGIN');

    // 1. Ensure participant exists
    const participantCheck = await client.query(
      `SELECT participant_id, full_name, email FROM participants WHERE participant_id = $1`,
      [participant_id]
    );

    if (participantCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'Participant not found' });
    }

    // 2. Check for existing payment for this participant
    const existingPayment = await client.query(
      `SELECT payment_id, transaction_id, verified_by_admin 
       FROM payments 
       WHERE participant_id = $1 
       AND payment_status = 'Success'
       ORDER BY created_at DESC
       LIMIT 1`,
      [participant_id]
    );

    let payment_id;
    let transaction_id;

    if (existingPayment.rowCount > 0) {
      const payment = existingPayment.rows[0];
      
      // If already verified, return info
      if (payment.verified_by_admin) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ 
          error: 'Payment already verified',
          payment_id: payment.payment_id,
          transaction_id: payment.transaction_id
        });
      }
      
      // Update existing payment to verified
      await client.query(
        `UPDATE payments 
         SET verified_by_admin = true,
             verified_at = NOW(),
             notes = COALESCE(notes || ', ', '') || 'Manually verified by admin'
         WHERE payment_id = $1
         RETURNING payment_id, transaction_id`,
        [payment.payment_id]
      );
      
      payment_id = payment.payment_id;
      transaction_id = payment.transaction_id;
    } else {
      // 3. Create new manual payment only if no payment exists
      const paymentResult = await client.query(
        `INSERT INTO payments (
          participant_id,
          transaction_id,
          amount,
          payment_method,
          payment_status,
          verified_by_admin,
          verified_at,
          notes,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW())
        RETURNING payment_id, transaction_id`,
        [
          participant_id,
          `MANUAL-${Date.now()}`,
          0,
          'Manual Verification',
          'Success',
          true,
          `Manually verified by admin for participant ${participant_id}`
        ]
      );
      
      payment_id = paymentResult.rows[0].payment_id;
      transaction_id = paymentResult.rows[0].transaction_id;
    }

    // 4. Update registrations payment status
    await client.query(
      `UPDATE registrations
       SET payment_status = 'Success'
       WHERE participant_id = $1
       AND payment_status = 'Pending'`,
      [participant_id]
    );

    await client.query('COMMIT');

    // Invalidate caches
    await invalidateParticipantCache(participant_id);
    await invalidateStatsCache();

    return {
      success: true,
      message: 'Participant manually verified',
      participant_id,
      participant_name: participantCheck.rows[0].full_name,
      payment_id,
      transaction_id,
      action: existingPayment.rowCount > 0 ? 'updated_existing_payment' : 'created_new_payment'
    };

  } catch (error) {
    await client.query('ROLLBACK');
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Manual verification failed' });
  } finally {
    client.release();
  }
});


// -------------------- Scan QR & Mark Attendance by Registration --------------------
fastify.post('/api/scan-attendance', async (request, reply) => {
  const client = await pool.connect();

  try {
    const { registration_id, qr_data } = request.body;

    if (!registration_id && !qr_data) {
      return reply.code(400).send({ 
        success: false,
        error: 'registration_id or qr_data is required' 
      });
    }

    let targetRegistrationId = registration_id;
    
    // FAST QR PARSING - Handle optimized payload
    if (qr_data && !registration_id) {
      try {
        const qr = typeof qr_data === 'string' ? JSON.parse(qr_data) : qr_data;
        // Extract first ID from pipe-separated string
        if (qr.ids) targetRegistrationId = qr.ids.split('|')[0];
        else if (qr.regs) targetRegistrationId = qr.regs.split('|')[0];
        else if (qr.registration_ids) targetRegistrationId = qr.registration_ids[0];
      } catch (e) {
        targetRegistrationId = qr_data;
      }
    }

    if (!targetRegistrationId) {
      return reply.code(400).send({ 
        success: false,
        error: 'Could not extract registration ID' 
      });
    }

    // 1️⃣ OPTIMIZED: Single query with ALL needed data
    const { rows } = await client.query(
      `SELECT 
          r.registration_unique_id,
          r.attendance_status,
          r.event_id,
          r.participant_id,
          r.payment_status,
          r.amount_paid,
          r.event_name,

          e.event_type,
          e.fee,

          p.full_name,
          p.email,
          p.college_name,
          p.department,
          p.year_of_study,

          -- Get admin verification in same query
          (SELECT verified_by_admin FROM payments 
           WHERE participant_id = r.participant_id 
           ORDER BY created_at DESC LIMIT 1) as verified_by_admin

       FROM registrations r
       JOIN participants p ON r.participant_id = p.participant_id
       JOIN events e ON r.event_id = e.event_id
       WHERE r.registration_unique_id = $1`,
      [targetRegistrationId]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ 
        success: false,
        error: 'Registration not found' 
      });
    }

    const reg = rows[0];
    const eventType = reg.event_type;
    const verifiedByAdmin = reg.verified_by_admin || false;
    const yearOfStudy = parseInt(reg.year_of_study);

    // 2️⃣ CHECK IF ATTENDANCE ALREADY MARKED
    if (reg.attendance_status === 'ATTENDED') {
      return reply.send({
        success: true,
        message: '✅ Attendance already marked',
        registration_id: reg.registration_unique_id,
        participant_id: reg.participant_id,
        participant_name: reg.full_name,
        event_type: eventType
      });
    }

    // 3️⃣ CHECK IF SONACSE
    const isSonacse = reg.registration_unique_id.startsWith('THREADS26-SONA-');

    // 4️⃣ ATTENDANCE RULES BASED ON STUDENT TYPE AND YEAR
    let canMark = false;
    let message = '';
    let paymentInfo = null;

    if (isSonacse) {
      // ========== SONACSE STUDENTS ==========
      if (eventType !== 'workshop') {
        // SONACSE EVENTS
        if (yearOfStudy >= 2 && yearOfStudy <= 4) {
          // 2nd-4th YEAR: NO CHECKS AT ALL - DIRECT ATTENDANCE ✅
          canMark = true;
          message = `✅ SONACSE Year ${yearOfStudy} Event attendance marked (Free Event - No verification needed)`;
          console.log(`SONACSE Year ${yearOfStudy} event - NO CHECKS applied`);
        } else {
          // 1st YEAR: Need admin verification and payment check
          if (!verifiedByAdmin) {
            return reply.code(403).send({
              success: false,
              participant_type: 'SONACSE',
              event_type: 'EVENT',
              year: yearOfStudy,
              message: 'First year SONACSE payment not verified',
              details: 'Admin verification required for first year events',
              registration_id: reg.registration_unique_id,
              participant_id: reg.participant_id,
              amount_paid: reg.amount_paid,
              suggestion: 'Wait for admin verification'
            });
          }
          
          if (reg.payment_status !== 'Success' && parseFloat(reg.amount_paid) > 0) {
            return reply.code(403).send({
              success: false,
              participant_type: 'SONACSE',
              event_type: 'EVENT',
              year: yearOfStudy,
              message: 'First year payment not completed',
              details: `Payment status: ${reg.payment_status}`,
              registration_id: reg.registration_unique_id,
              participant_id: reg.participant_id,
              amount_paid: reg.amount_paid
            });
          }
          
          canMark = true;
          message = '✅ SONACSE First Year Event attendance marked (₹50 discount applied)';
          paymentInfo = {
            amount_paid: reg.amount_paid,
            payment_status: reg.payment_status,
            admin_verified: verifiedByAdmin,
            discount: '₹50 off total events'
          };
        }
      } else {
        // SONACSE WORKSHOPS - Need verification for ALL years (1st-4th)
        if (!verifiedByAdmin) {
          return reply.code(403).send({
            success: false,
            participant_type: 'SONACSE',
            event_type: 'WORKSHOP',
            year: yearOfStudy,
            message: 'SONACSE workshop payment not verified by admin',
            details: 'Admin verification required for all workshop attendance',
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            amount_paid: reg.amount_paid,
            suggestion: 'Wait for admin verification'
          });
        }

        if (reg.payment_status !== 'Success') {
          return reply.code(403).send({
            success: false,
            participant_type: 'SONACSE',
            event_type: 'WORKSHOP',
            year: yearOfStudy,
            message: 'SONACSE workshop payment not completed',
            details: `Payment status: ${reg.payment_status}`,
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            amount_paid: reg.amount_paid
          });
        }

        canMark = true;
        message = `✅ SONACSE Year ${yearOfStudy} Workshop attendance marked (₹100 discount applied)`;
        paymentInfo = {
          amount_paid: reg.amount_paid,
          payment_status: reg.payment_status,
          admin_verified: verifiedByAdmin,
          original_fee: 400,
          discount_applied: 100,
          final_fee: reg.amount_paid
        };
      }
    } else {
      // ========== REGULAR (NON-SONACSE) STUDENTS ==========
      if (eventType !== 'workshop') {
        // REGULAR EVENTS - Need admin verification only
        if (!verifiedByAdmin) {
          return reply.code(403).send({
            success: false,
            participant_type: 'REGULAR',
            event_type: 'EVENT',
            message: 'Payment not verified by admin',
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            details: 'Admin verification required for event attendance',
            suggestion: 'Wait for admin verification'
          });
        }

        canMark = true;
        message = '✅ Event attendance marked';
        paymentInfo = {
          admin_verified: verifiedByAdmin
        };
      } else {
        // REGULAR WORKSHOPS - Need both admin verification AND payment success
        if (!verifiedByAdmin) {
          return reply.code(403).send({
            success: false,
            participant_type: 'REGULAR',
            event_type: 'WORKSHOP',
            message: 'Payment not verified by admin',
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            details: 'Admin verification required for workshop attendance'
          });
        }

        if (reg.payment_status !== 'Success') {
          return reply.code(403).send({
            success: false,
            participant_type: 'REGULAR',
            event_type: 'WORKSHOP',
            message: 'Workshop payment not completed',
            details: `Payment status: ${reg.payment_status}`,
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            amount_paid: reg.amount_paid
          });
        }

        canMark = true;
        message = '✅ Workshop attendance marked';
        paymentInfo = {
          amount_paid: reg.amount_paid,
          payment_status: reg.payment_status,
          admin_verified: verifiedByAdmin
        };
      }
    }

    // 5️⃣ MARK ATTENDANCE
    if (canMark) {
      const result = await client.query(
        `UPDATE registrations
         SET attendance_status = 'ATTENDED',
             attended_at = NOW()
         WHERE registration_unique_id = $1
         RETURNING registration_unique_id, attendance_status, event_id`,
        [targetRegistrationId]
      );

      // Clear any cached data
      if (global.redis) {
        redis.del(`attendance:${targetRegistrationId}`).catch(() => {});
      }

      return reply.send({
        success: true,
        message: message,
        participant_type: isSonacse ? 'SONACSE' : 'REGULAR',
        event_type: eventType,
        year_of_study: isSonacse ? yearOfStudy : null,
        registration: result.rows[0],
        participant: {
          participant_id: reg.participant_id,
          full_name: reg.full_name,
          college_name: reg.college_name,
          department: reg.department
        },
        payment_info: paymentInfo
      });
    }

    return reply.code(500).send({
      success: false,
      error: 'Unable to determine attendance eligibility'
    });

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ 
      success: false,
      error: 'Failed to mark attendance',
      details: error.message 
    });
  } finally {
    client.release();
  }
});


// -------------------- Mark Attendance by Participant ID (Manual Fallback) --------------------
fastify.post('/api/manual-attendance', async (request, reply) => {
  const client = await pool.connect();

  try {
    const { participant_id, event_id } = request.body;

    if (!participant_id || !event_id) {
      return reply.code(400).send({ 
        success: false,
        error: 'participant_id and event_id are required' 
      });
    }

    // 1️⃣ Get registration details using participant_id and event_id
    const { rows } = await client.query(
      `SELECT 
          r.registration_unique_id,
          r.attendance_status,
          r.event_id,
          r.participant_id,
          r.payment_status,
          r.amount_paid,
          r.event_name,

          e.event_type,  -- Get event type: 'workshop', 'technical', 'non-technical', etc.
          e.fee,

          p.full_name,
          p.email,
          p.college_name,
          p.department

       FROM registrations r
       JOIN participants p ON r.participant_id = p.participant_id
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1 AND r.event_id = $2
       LIMIT 1`,
      [participant_id, event_id]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ 
        success: false,
        error: 'Registration not found for this participant and event' 
      });
    }

    const reg = rows[0];
    const eventType = reg.event_type;

    // 2️⃣ CHECK IF ATTENDANCE ALREADY MARKED
    if (reg.attendance_status === 'ATTENDED') {
      return reply.send({
        success: true,
        message: '✅ Attendance already marked',
        registration_id: reg.registration_unique_id,
        participant_id: reg.participant_id,
        participant_name: reg.full_name,
        event_type: eventType,
        mode: 'MANUAL_FALLBACK'
      });
    }

    // 3️⃣ CHECK IF THIS IS A SONACSE REGISTRATION
    const isSonacse = reg.registration_unique_id.startsWith('THREADS26-SONA-');
    
    // 4️⃣ GET ADMIN VERIFICATION STATUS (for both SONACSE and others)
    const paymentCheck = await client.query(
      `SELECT 
        py.verified_by_admin
       FROM payments py
       WHERE py.participant_id = $1
       ORDER BY py.created_at DESC
       LIMIT 1`,
      [reg.participant_id]
    );

    const verifiedByAdmin = paymentCheck.rows[0]?.verified_by_admin || false;

    // 5️⃣ LOGIC BASED ON STUDENT TYPE AND EVENT TYPE
    
    // ------ SONACSE STUDENTS ------
    if (isSonacse) {
      // SONACSE EVENT (non-workshop) - NO CHECKS
      if (eventType !== 'workshop') {
        const result = await client.query(
          `UPDATE registrations
           SET attendance_status = 'ATTENDED',
               attended_at = NOW()
           WHERE registration_unique_id = $1
           RETURNING registration_unique_id, attendance_status, event_id`,
          [reg.registration_unique_id]
        );

        return reply.send({
          success: true,
          message: '✅ SONACSE Event attendance marked successfully (Manual)',
          participant_type: 'SONACSE',
          event_type: 'EVENT',
          mode: 'MANUAL_FALLBACK',
          registration: result.rows[0],
          participant: {
            participant_id: reg.participant_id,
            full_name: reg.full_name,
            college_name: reg.college_name,
            department: reg.department
          },
          note: 'SONACSE events are free - no verification required'
        });
      }
      // SONACSE WORKSHOP - CHECK BOTH PAYMENT AND ADMIN VERIFICATION
      else if (eventType === 'workshop') {
        // Check admin verification
        if (!verifiedByAdmin) {
          return reply.code(403).send({
            success: false,
            participant_type: 'SONACSE',
            event_type: 'WORKSHOP',
            mode: 'MANUAL_FALLBACK',
            message: 'SONACSE workshop payment not verified by admin',
            details: 'Admin verification required for SONACSE workshop attendance',
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            amount_paid: reg.amount_paid,
            suggestion: 'Wait for admin verification or contact SONACSE coordinators'
          });
        }

        // Check payment status
        if (reg.payment_status !== 'Success') {
          return reply.code(403).send({
            success: false,
            participant_type: 'SONACSE',
            event_type: 'WORKSHOP',
            mode: 'MANUAL_FALLBACK',
            message: 'SONACSE workshop payment not completed',
            details: `Payment status: ${reg.payment_status}`,
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            amount_paid: reg.amount_paid,
            suggestion: 'Complete payment to attend workshop'
          });
        }

        const result = await client.query(
          `UPDATE registrations
           SET attendance_status = 'ATTENDED',
               attended_at = NOW()
           WHERE registration_unique_id = $1
           RETURNING registration_unique_id, attendance_status, event_id`,
          [reg.registration_unique_id]
        );

        return reply.send({
          success: true,
          message: '✅ SONACSE Workshop attendance marked successfully (Manual)',
          participant_type: 'SONACSE',
          event_type: 'WORKSHOP',
          mode: 'MANUAL_FALLBACK',
          registration: result.rows[0],
          participant: {
            participant_id: reg.participant_id,
            full_name: reg.full_name,
            college_name: reg.college_name,
            department: reg.department
          },
          payment_info: {
            amount_paid: reg.amount_paid,
            payment_status: reg.payment_status,
            admin_verified: verifiedByAdmin
          }
        });
      }
    }
    // ------ OTHER STUDENTS ------
    else {
      // OTHER STUDENTS EVENT - CHECK ONLY ADMIN VERIFICATION
      if (eventType !== 'workshop') {
        // Check admin verification
        if (!verifiedByAdmin) {
          return reply.code(403).send({
            success: false,
            participant_type: 'REGULAR',
            event_type: 'EVENT',
            mode: 'MANUAL_FALLBACK',
            message: 'Payment not verified by admin. Attendance cannot be marked.',
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            details: 'Admin verification required for event attendance'
          });
        }

        const result = await client.query(
          `UPDATE registrations
           SET attendance_status = 'ATTENDED',
               attended_at = NOW()
           WHERE registration_unique_id = $1
           RETURNING registration_unique_id, attendance_status, event_id`,
          [reg.registration_unique_id]
        );

        return reply.send({
          success: true,
          message: '✅ Event attendance marked successfully (Manual)',
          participant_type: 'REGULAR',
          event_type: 'EVENT',
          mode: 'MANUAL_FALLBACK',
          registration: result.rows[0],
          participant: {
            participant_id: reg.participant_id,
            full_name: reg.full_name,
            college_name: reg.college_name,
            department: reg.department
          },
          payment_info: {
            admin_verified: verifiedByAdmin
          }
        });
      }
      // OTHER STUDENTS WORKSHOP - CHECK BOTH PAYMENT AND ADMIN VERIFICATION
      else if (eventType === 'workshop') {
        // Check admin verification
        if (!verifiedByAdmin) {
          return reply.code(403).send({
            success: false,
            participant_type: 'REGULAR',
            event_type: 'WORKSHOP',
            mode: 'MANUAL_FALLBACK',
            message: 'Payment not verified by admin. Attendance cannot be marked.',
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            details: 'Admin verification required for workshop attendance'
          });
        }

        // Check payment status
        if (reg.payment_status !== 'Success') {
          return reply.code(403).send({
            success: false,
            participant_type: 'REGULAR',
            event_type: 'WORKSHOP',
            mode: 'MANUAL_FALLBACK',
            message: 'Workshop payment not completed',
            details: `Payment status: ${reg.payment_status}`,
            registration_id: reg.registration_unique_id,
            participant_id: reg.participant_id,
            amount_paid: reg.amount_paid
          });
        }

        const result = await client.query(
          `UPDATE registrations
           SET attendance_status = 'ATTENDED',
             attended_at = NOW()
           WHERE registration_unique_id = $1
           RETURNING registration_unique_id, attendance_status, event_id`,
          [reg.registration_unique_id]
        );

        return reply.send({
          success: true,
          message: '✅ Workshop attendance marked successfully (Manual)',
          participant_type: 'REGULAR',
          event_type: 'WORKSHOP',
          mode: 'MANUAL_FALLBACK',
          registration: result.rows[0],
          participant: {
            participant_id: reg.participant_id,
            full_name: reg.full_name,
            college_name: reg.college_name,
            department: reg.department
          },
          payment_info: {
            amount_paid: reg.amount_paid,
            payment_status: reg.payment_status,
            admin_verified: verifiedByAdmin
          }
        });
      }
    }

    // If we reach here, event_type is valid but logic didn't match
    const result = await client.query(
      `UPDATE registrations
       SET attendance_status = 'ATTENDED',
           attended_at = NOW()
       WHERE registration_unique_id = $1
       RETURNING registration_unique_id, attendance_status, event_id`,
      [reg.registration_unique_id]
    );

    return reply.send({
      success: true,
      message: '✅ Attendance marked successfully (Manual)',
      mode: 'MANUAL_FALLBACK',
      registration: result.rows[0],
      participant: {
        participant_id: reg.participant_id,
        full_name: reg.full_name,
        college_name: reg.college_name,
        department: reg.department
      }
    });

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ 
      success: false,
      error: 'Failed to mark attendance manually',
      details: error.message 
    });
  } finally {
    client.release();
  }
});




  // -------------------- Search Participants for Manual Attendance --------------------
fastify.get('/api/search-participants', async (request, reply) => {
  const client = await pool.connect();

  try {
    const { search, event_id } = request.query;

    if (!search) {
      return reply.code(400).send({ 
        success: false,
        error: 'Search query is required' 
      });
    }

    let query = `
      SELECT 
        p.participant_id,
        p.full_name,
        p.email,
        p.college_name,
        p.department,
        p.phone,
        
        r.registration_unique_id,
        r.event_id,
        r.event_name,
        r.attendance_status,
        r.payment_status,
        r.amount_paid,
        r.created_at as registration_date,
        
        e.event_type,
        e.fee,
        e.event_date
        
      FROM participants p
      JOIN registrations r ON p.participant_id = r.participant_id
      JOIN events e ON r.event_id = e.event_id
      WHERE (p.full_name ILIKE $1 OR p.email ILIKE $1 OR p.phone ILIKE $1)
    `;

    const params = [`%${search}%`];
    
    if (event_id) {
      query += ` AND r.event_id = $2`;
      params.push(event_id);
    }

    query += ` ORDER BY p.full_name, r.created_at DESC LIMIT 20`;

    const { rows } = await client.query(query, params);

    if (rows.length === 0) {
      return reply.code(404).send({ 
        success: false,
        error: 'No participants found' 
      });
    }

    return reply.send({
      success: true,
      count: rows.length,
      participants: rows
    });

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ 
      success: false,
      error: 'Search failed',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// 8. Get Attendance Report
fastify.get('/api/admin/attendance-report', async (request) => {
  // Verify admin token

  
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



// 10. Export Registrations (Admin)
fastify.get('/api/admin/export', async (request, reply) => {
  // Verify admin token

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
        p.gender,
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


fastify.get('/api/participant/:id/verification-status', async (request, reply) => {
  try {
    const { id } = request.params;
    const cacheKey = `verification:${id}`;
    
    // Try cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
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
    
    const response = {
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
      }
    };
    
    // Cache for 30 seconds
    await redis.setex(cacheKey, 30, JSON.stringify(response));
    
    return response;
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// SIMPLE ALL-IN-ONE PARTICIPANT ENDPOINT
fastify.get('/api/participant/:id/all', async (request, reply) => {
  try {
    const { id } = request.params;
    
    // 1. Get participant basic info
    const participant = await pool.query(
      'SELECT participant_id, full_name, email, phone, college_name, department, year_of_study, city, state, gender FROM participants WHERE participant_id = $1',
      [id]
    );
    
    if (participant.rows.length === 0) {
      return reply.code(404).send({ 
        error: 'Participant not found',
        participant_id: id 
      });
    }
    
    // 2. Get all registrations with event details
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
       WHERE r.participant_id = $1
       ORDER BY e.day, e.event_name`,
      [id]
    );
    
    // 3. Get payment info
    const payments = await pool.query(
      `SELECT 
        transaction_id,
        amount,
        payment_method,
        payment_status,
        verified_by_admin,
        verified_at,
        created_at
       FROM payments 
       WHERE participant_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    
    // 4. Calculate simple status
    const paymentStatus = payments.rows.length > 0 ? 
      (payments.rows[0].verified_by_admin ? 'ADMIN_VERIFIED' : 
       payments.rows[0].payment_status === 'Success' ? 'AUTO_VERIFIED' : 'NOT_VERIFIED') 
      : 'NOT_VERIFIED';
    
    // 5. Calculate totals
    const totalPaid = registrations.rows.filter(r => r.payment_status === 'Success').length;
    const totalPending = registrations.rows.filter(r => r.payment_status === 'Pending').length;
    const totalAmount = payments.rows.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    
    // 6. Group registrations by day for easier display
    const registrationsByDay = {
      day1: registrations.rows.filter(r => r.day === 1),
      day2: registrations.rows.filter(r => r.day === 2)
    };
    
    // 7. Return everything in one response
    return {
      success: true,
      participant: participant.rows[0],
      verification_status: paymentStatus,
      payment_summary: {
        total_registrations: registrations.rows.length,
        paid_registrations: totalPaid,
        pending_registrations: totalPending,
        total_amount: totalAmount
      },
      registrations: registrations.rows,
      registrations_by_day: registrationsByDay,
      payments: payments.rows,
      last_updated: new Date().toISOString()
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ 
      error: 'Failed to load participant data',
      details: error.message 
    });
  }
});

// SIMPLE TRACK ENDPOINT (for registration IDs)
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
        e.fee
       FROM registrations r
       JOIN participants p ON r.participant_id = p.participant_id
       JOIN events e ON r.event_id = e.event_id
       WHERE r.registration_unique_id = $1`,
      [registration_id]
    );
    
    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Registration not found' });
    }
    
    return {
      registration: result.rows[0],
      found: true
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

fastify.get('/api/admin/stats', async (request) => {
  const cacheKey = 'admin_stats';
  
  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  
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
    
    const result = {
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
    
    // Cache for 60 seconds (stats update every minute is fine)
    await redis.setex(cacheKey, 60, JSON.stringify(result));
    
    return result;
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});


// Add these after Redis setup
const invalidateCache = async (pattern) => {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    console.error('Error invalidating cache:', err);
  }
};

// Specific cache invalidation functions
const invalidateEventsCache = async () => {
  await invalidateCache('events:*');
  await invalidateCache('seats:*');
};

const invalidateParticipantCache = async (participantId) => {
  await redis.del(`verification:${participantId}`);
  await invalidateCache(`track:*`); // Invalidate all tracking
};

const invalidateStatsCache = async () => {
  await redis.del('admin_stats');
};

const invalidateGalleryCache = async () => {
  await invalidateCache('gallery:*');
};

const invalidateAnnouncementsCache = async () => {
  await redis.del('announcements');
};







// 15. Create announcement (Admin)
fastify.post('/api/admin/announcements', async (request, reply) => {

  
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

// 17. Create announcement
fastify.post('/api/announcements', async (request, reply) => {
  const { title, message, expires_at, is_active = true } = request.body;

  try {
    const result = await pool.query(
      `INSERT INTO announcements (title, message, expires_at, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, message, expires_at, is_active]
    );

    reply.code(201).send(result.rows[0]);
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to create announcement' });
  }
});


// 18. Delete announcement
fastify.delete('/api/announcements/:id', async (request, reply) => {
  const { id } = request.params;

  try {
    const result = await pool.query(
      `DELETE FROM announcements WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'Announcement not found' });
    }

    reply.send({ message: 'Announcement deleted successfully' });
  } catch (error) {
    fastify.log.error(error);
    reply.code(500).send({ error: 'Failed to delete announcement' });
  }
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





const SONACSE_STUDENTS = {
  '61782323102001': 'ABHISHEK K U',
  '61782323102002': 'ABINAYA C',
  '61782323102003': 'ABIRAMI M',
  '61782323102004': 'AGALYA M',
  '61782323102005': 'AISHWARYA R',
  '61782323102006': 'AKSHAYA N',
  '61782323102007': 'ALRIFA I',
  '61782323102008': 'ANFAZ SULTHAN',
  '61782323102009': 'ARCCHANA K',
  '61782323102010': 'ARCHANA S',
  '61782323102011': 'ARNOLD PHILIP',
  '61782323102012': 'ASHIQ MOHAMED A',
  '61782323102013': 'ASWIN T U',
  '61782323102014': 'BALAHARIHARAN K S',
  '61782323102015': 'BHAGYASHREE S',
  '61782323102017': 'BHAVADHARINI K',
  '61782323102018': 'BHAVITRA S',
  '61782323102019': 'BUVANA N',
  '61782323102021': 'CHIDAMBARAM U M',
  '61782323102022': 'DEEPAK S S',
  '61782323102023': 'DEEPAKKUMAR K M',
  '61782323102024': 'DEEPASRI T',
  '61782323102025': 'DHANUSHBALAJI P',
  '61782323102026': 'DHANUSRI V',
  '61782323102027': 'DHARANISH M',
  '61782323102028': 'DHARSHANA R',
  '61782323102029': 'DHARUNKUMAR S',
  '61782323102030': 'DHINESH S',
  '61782323102031': 'DHINESHKUMAR P',
  '61782323102032': 'DHIYANESH B',
  '61782323102033': 'DHURAISAMY P',
  '61782323102034': 'DINESH KUMAR S',
  '61782323102035': 'DIVYAASHRE E G',
  '61782323102036': 'DIVYADHARSHINI M',
  '61782323102037': 'EIKJAS ALI KHAN M',
  '61782323102038': 'ELAKKIYA K',
  '61782323102039': 'ELLAYA VIGNESH C',
  '61782323102040': 'GAJENDRA M',
  '61782323102041': 'GAYATHRI M',
  '61782323102042': 'GOKULAVAASAN B',
  '61782323102043': 'GOPI G',
  '61782323102044': 'GOPIKA K',
  '61782323102045': 'GOWDHAM RAJ A',
  '61782323102046': 'GRACE CHRISTEL C',
  '61782323102047': 'HARIHARAN N',
  '61782323102048': 'HARINI B',
  '61782323102049': 'HARINI G S',
  '61782323102050': 'HARINI T',
  '61782323102051': 'Harish V',
  '61782323102052': 'Indhumathi S',
  '61782323102053': 'Janakiraman S',
  '61782323102054': 'Jaya bharathC',
  '61782323102055': 'Jeeva DharshiniT',
  '61782323102056': 'Jeevanprakash P',
  '61782323102057': 'JEROME JOHN ITTY',
  '61782323102058': 'Jothishree B E',
  '61782323102059': 'KabilanR',
  '61782323102060': 'Kamala JananiK',
  '61782323102061': 'KamaleshS',
  '61782323102062': 'kanaparthi pavan datta',
  '61782323102063': 'KanishkaM',
  '61782323102064': 'karthigaS',
  '61782323102065': 'Karthikeyan R',
  '61782323102066': 'Karthikeyan S',
  '61782323102067': 'Kashif Ahamad S',
  '61782323102068': 'Kavipriya A S',
  '61782323102069': 'kaviyashri V',
  '61782323102070': 'Keerthi G',
  '61782323102071': 'KeerthickS',
  '61782323102073': 'kiruthiga G',
  '61782323102074': 'KrishnaKumar D',
  '61782323102075': 'Kritika B',
  '61782323102076': 'KumudiniS',
  '61782323102077': 'LaksharaRR',
  '61782323102078': 'Lenin S',
  '61782323102079': 'Lithwin ShujiJ',
  '61782323102080': 'LokeshN',
  '61782323102081': 'Lokeshwaran R',
  '61782323102082': 'Macernestantony D',
  '61782323102083': 'Madhusri V',
  '61782323102084': 'Malini VP',
  '61782323102085': 'Manasvi Sharad mali',
  '61782323102086': 'Manoj Kumar R',
  '61782323102087': 'Manolashini V',
  '61782323102088': 'Manoshankari V',
  '61782323102089': 'Meenashalini P',
  '61782323102090': 'Megashree M',
  '61782323102091': 'Meiyarasan S',
  '61782323102093': 'Mohammed AliA',
  '61782323102094': 'Mohammed SufiyaanI',
  '61782323102095': 'Mona RachelD C',
  '61782323102096': 'MounikaV',
  '61782323102097': 'Mouriya V K',
  '61782323102098': 'Nakshathra S',
  '61782323102099': 'Nandhakishore K G',
  '61782323102101': 'Naveen G',
  '61782323102102': 'Naveen kumar T',
  '61782323102103': 'Naveen.N',
  '61782323102104': 'Naveenkumar p',
  '61782323102105': 'Navinadarshan.V',
  '61782323102106': 'Negha S',
  '61782323102107': 'NEHAL KESAVAN',
  '61782323102108': 'Niranjan S',
  '61782323102109': 'Nishalini S',
  '61782323102110': 'Nithishkanna B',
  '61782323102112': 'Nitish Roshaan. S',
  '61782323102113': 'Nivedhithasri S',
  '61782323102114': 'Nivithapriya R S',
  '61782323102115': 'PARASH DAULYAL',
  '61782323102116': 'Pavinithi N K',
  '61782323102117': 'PAVISHYA P L',
  '61782323102118': 'Poovarasan C',
  '61782323102119': 'Poovarasan s',
  '61782323102120': 'Pradhiksha',
  '61782323102121': 'Pranav Karthik S S',
  '61782323102122': 'Praneesh s',
  '61782323102123': 'PRANESH K K',
  '61782323102124': 'Praveen B',
  '61782323102125': 'Preethi S',
  '61782323102126': 'Priya P',
  '61782323102127': 'RAHUL K',
  '61782323102128': 'RAHUL NS',
  '61782323102129': 'Ram Priya M',
  '61782323102130': 'RAMANSH TOMAR',
  '61782323102131': 'RAMBILAS SAH',
  '61782323102132': 'RAMYA S',
  '61782323102133': 'Rashmi M',
  '61782323102134': 'Riteshkumaran',
  '61782323102135': 'Rithish.I',
  '61782323102136': 'Roopika E',
  '61782323102137': 'Sagaran S',
  '61782323102138': 'SAI RAJA RAJAN JK',
  '61782323102139': 'Sailekha M',
  '61782323102140': 'Salvi B',
  '61782323102142': 'Sanjana M',
  '61782323102143': 'Sanjana.R',
  '61782323102144': 'Sanjay J',
  '61782323102145': 'Sanjay Prasath M',
  '61782323102146': 'Sanjay prakash.G',
  '61782323102147': 'Santhosh Kumar JP',
  '61782323102148': 'Santhosh S.K',
  '61782323102149': 'Sethuraman A',
  '61782323102150': 'Shalini M',
  '61782323102151': 'Sharan D',
  '61782323102152': 'Shifana Fathima M',
  '61782323102153': 'SHREE NIKESH R',
  '61782323102154': 'SHREESARVESH S G',
  '61782323102155': 'SHRI DHARSHINI S',
  '61782323102156': 'SHUBHAGITA P S',
  '61782323102157': 'SIBINESHWARAN S',
  '61782323102158': 'SIVATMIKA A',
  '61782323102159': 'SOBHIKASRI J',
  '61782323102160': 'SOPHIE CHRISTINA A',
  '61782323102161': 'SOWBARANIKA A',
  '61782323102162': 'SOWNDHARYA G',
  '61782323102163': 'SOWRNALATHA A',
  '61782323102164': 'SRI BHUMA S',
  '61782323102165': 'SRI SARAVANAVEL G',
  '61782323102166': 'SRI VIMALRAJ S',
  '61782323102167': 'SRIDHARAN S S',
  '61782323102168': 'SRIDHARANISH K',
  '61782323102169': 'SRINAGAPRIYA A',
  '61782323102170': 'SRINIVASA RAJAN M',
  '61782323102171': 'SRI RANGANATHAN S',
  '61782323102172': 'SUBASH CHANDRA BOSE S',
  '61782323102173': 'SUDHARSHINEE  S K',
  '61782323102174': 'SUGUMARAN S',
  '61782323102175': 'SUJITHRA R',
  '61782323102176': 'SUPREETHA J U',
  '61782323102177': 'SURUTHIKA R',
  '61782323102178': 'SURYA  S',
  '61782323102179': 'TAMIL B S',
  '61782323102180': 'TANUSHREE T B',
  '61782323102181': 'THIRUVELAN C',
  '61782323102182': 'VAIBHAVAKANNA P',
  '61782323102183': 'VAISHNAVI K',
  '61782323102184': 'VAISHNAVI M',
  '61782323102185': 'VALARMATHI A',
  '61782323102186': 'VANITHA N',
  '61782323102187': 'VARSHINI M',
  '61782323102188': 'VARSHITHA SHIVAKUMAR',
  '61782323102189': 'VASANTHAKUMAR S',
  '61782323102190': 'VIDHYA S',
  '61782323102191': 'VIJAYAMILAN V',
  '61782323102192': 'VIMALRAGHAV M',
  '61782323102193': 'VISHAL V',
  '61782323102194': 'VISHNU PRASANTH K',
  '61782323102195': 'VISHWA J',
  '61782323102196': 'VITHUN S',
  '61782323102197': 'VIVEGANANDAN S',
  '61782323102198': 'YOGESH C',
  '61782323102701': 'Ashwin Shriram RC',
  '61782323102702': 'DEEPAK P',
  '61782323102706': 'LokeswaranG',
  '61782323102707': 'MAHAVISHNU',
  '61782323102708': 'MANISH PRITHIV R',
  '61782323102711': 'Nishvan Kumar. M',
  '61782323102713': 'Sakthivel S',
  '61782323102714': 'SANJJITH S',
  '61782323102715': 'Sathiya.S',
  '61782323102716': 'SOUNDHAR D',
  '61782323102721': 'Ragul S',
  '61782323111001': 'ABHINAV GEORGE',
  '61782323111002': 'ADHYANDH ROBIN SANJAY G S',
  '61782323111003': 'AFRINS',
  '61782323111004': 'AKASH B',
  '61782323111005': 'ALFADEENI',
  '61782323111006': 'ANANTH KARTHIKV',
  '61782323111007': 'ARAVINDKUMAR R',
  '61782323111008': 'ARUL R',
  '61782323111012': 'CHANDRUK',
  '61782323111013': 'DIVYA PRAKASHKANDEEBAN',
  '61782323111015': 'HARISANKARA',
  '61782323111016': 'HARISH MADHAVANV',
  '61782323111017': 'HARSHINIG',
  '61782323111019': 'JAI SAI KISHOREB',
  '61782323111020': 'JEEVANANTHAM RAJARAM',
  '61782323111021': 'JOHNSHI ELENAA',
  '61782323111022': 'JOSHIKAAK',
  '61782323111023': 'JUSTINJOHN',
  '61782323111024': 'KALAIYARASAN K D',
  '61782323111025': 'KAMESHWARANK',
  '61782323111026': 'KANISH V',
  '61782323111027': 'KANISHMAS',
  '61782323111029': 'KAVIARASUG',
  '61782323111030': 'KISHOREKUMAR M',
  '61782323111031': 'KISHORE KUMARU',
  '61782323111032': 'LIVYAA',
  '61782323111033': 'LOKESHWARANS',
  '61782323111035': 'PRIYANKAA MADU  SRM',
  '61782323111036': 'MAHENDIRANK S',
  '61782323111037': 'MOHAMMED USMAN',
  '61782323111038': 'NAGASURIMEERASH',
  '61782323111039': 'NAVEENKUMART',
  '61782323111040': 'NIDERSANAS B',
  '61782323111041': 'NIROSHINI K',
  '61782323111042': 'NISHANTH P',
  '61782323111043': 'PARVEZ AHAMEDS',
  '61782323111044': 'PAVITHRA AT',
  '61782323111045': 'PAVITHRA S',
  '61782323111046': 'PRAVEEN RAJ',
  '61782323111047': 'PRIYADHARSHINI M',
  '61782323111048': 'RAKKSITHA R',
  '61782323111049': 'RASIKA R G',
  '61782323111050': 'ROHITHV',
  '61782323111051': 'SAMKUMARS',
  '61782323111052': 'SARANR',
  '61782323111054': 'SHYAM SUNDAR',
  '61782323111055': 'SOWMINIS',
  '61782323111056': 'SRIKHANTHSURYAK S',
  '61782323111057': 'SUBASH N',
  '61782323111058': 'SUDARMANI V',
  '61782323111059': 'TANYA RAJ',
  '61782323111060': 'THARUNMURUGANANTHAM',
  '61782323111061': 'VARSHINIS',
  '61782323111062': 'VENIJ',
  '61782323111063': 'VISHWAJITH P L',
  '61782323111702': 'MOHAMMEDRIFATH MEERA',
  '61782323111703': 'SUBRAMANIAN GPH',
  '61782323111704': 'SUDHARSANS',
  '61782323112001': 'ABIRAMI R',
  '61782323112002': 'AFSARI BEGUM Z',
  '61782323112003': 'AKASHKUMARAN S',
  '61782323112004': 'AMEERA A',
  '61782323112005': 'ANUJPAREEK R',
  '61782323112006': 'ASWIN M',
  '61782323112007': 'BHARATH S',
  '61782323112008': 'BHUVANESHWARAN R',
  '61782323112009': 'CHARUMATHI M',
  '61782323112010': 'DHINAKARAN R',
  '61782323112011': 'DINESH KUMAR S M',
  '61782323112012': 'DIVYADHARSHINI V',
  '61782323112013': 'GAYATHRY S R',
  '61782323112014': 'JAGRUTHI SS',
  '61782323112015': 'JANAKA S',
  '61782323112016': 'JAYASUDHA J',
  '61782323112018': 'KAVIN K K',
  '61782323112020': 'KATHIRVEL M',
  '61782323112021': 'KAVIA RAGAVI KSR',
  '61782323112022': 'KAVYA D',
  '61782323112023': 'KEERTHAN KAMATH G',
  '61782323112024': 'KIRUBAVATHI P',
  '61782323112025': 'MADHUMIDHA M',
  '61782323112026': 'MADHURANDHAN VI',
  '61782323112027': 'MANEESHA K',
  '61782323112028': 'MANISHA V',
  '61782323112029': 'MANUSHREE S G',
  '61782323112030': 'MOHAN R',
  '61782323112031': 'MOREENA S R',
  '61782323112032': 'MOULIPACHAN S',
  '61782323112033': 'NAGULAN VIJAYAKUMAR',
  '61782323112034': 'NAVANEETHAN A R',
  '61782323112035': 'NAVEEN PRASANA',
  '61782323112036': 'NISHA G',
  '61782323112037': 'PRIYADHARSHINI J',
  '61782323112038': 'RAGASIYA M S',
  '61782323112039': 'RANJAN M',
  '61782323112040': 'REVATHI',
  '61782323112041': 'SABARI P',
  '61782323112042': 'SANDHIYA J S',
  '61782323112043': 'SANJAI S',
  '61782323112044': 'SARA FATHIMA A',
  '61782323112045': 'SELVARAGAVAN M',
  '61782323112046': 'SHAMIRA SHAHEEN S',
  '61782323112047': 'SHAZIA AKBAR',
  '61782323112048': 'SHUBHASHREE M',
  '61782323112049': 'SIVA SANKAR C',
  '61782323112050': 'SOWMIYA L',
  '61782323112051': 'SRI AISHWARYA G',
  '61782323112052': 'SRINITHI  A',
  '61782323112053': 'SUDHIPTI M',
  '61782323112054': 'SWASTHIK BHARGAV V',
  '61782323112055': 'TEJASVINI R',
  '61782323112056': 'THEJOMAYIE K',
  '61782323112057': 'VAISHINI J',
  '61782323112058': 'VARSHINI',
  '61782323112059': 'VASU S',
  '61782323112060': 'VIJAY V',
  '61782323112061': 'VIJAYALAKSHMI',
  '61782323112062': 'VIMAL RAJ S',
  '61782323112063': 'VISHNU ANAND S',
  '61782323112501': 'BOOBALAN M H',
  '61782323112701': 'ASHOK KUMAR K',
  '61782323112703': 'DHANUSHATHIRI A',
  '61782323112704': 'HARI PRASATH M M',
  '61782323112705': 'SUJEETH S',
  '61782324102001': 'AAFIYA S',
  '61782324102002': 'AAMIR KHAN S',
  '61782324102003': 'AASHISH SHARMA',
  '61782324102004': 'AATHISH M',
  '61782324102005': 'ABARNA A A',
  '61782324102006': 'ABINAYA G',
  '61782324102007': 'ABIRAMI B',
  '61782324102008': 'ADARSHA MURMU',
  '61782324102009': 'AGALYA V S',
  '61782324102010': 'AKHIL KUMAR S',
  '61782324102011': 'AKHSHAYA VARSHINEE BA',
  '61782324102012': 'AKSHAYA SREE P',
  '61782324102013': 'AKSHIYALAKSHMI G',
  '61782324102014': 'AMOGHA SHRE V',
  '61782324102015': 'AMRIN TAJ N',
  '61782324102016': 'AMSAVARDHINI G',
  '61782324102017': 'ANTONY XAVIER M',
  '61782324102018': 'ARIHARA SUTHAN L K',
  '61782324102019': 'ARMAAN AHMED N',
  '61782324102020': 'ARUL B',
  '61782324102021': 'ASWIN S',
  '61782324102022': 'ASWIN T',
  '61782324102023': 'AYMAN SHAREEF F',
  '61782324102024': 'BARATH V K',
  '61782324102025': 'BHARANI T',
  '61782324102026': 'BIPEEN YADAV',
  '61782324102027': 'BRUNDHA S',
  '61782324102028': 'CHANDAN SHAH',
  '61782324102029': 'CHANDRU A',
  '61782324102030': 'CHIRADEEP T D',
  '61782324102031': 'DARSHAA B',
  '61782324102032': 'DAYANIDHI VARMAA S N',
  '61782324102033': 'DAYASUBHASH J',
  '61782324102034': 'DEE ANN NATASHA V',
  '61782324102035': 'DEEPAKRAJA S',
  '61782324102036': 'DEVADHARSHINI N',
  '61782324102037': 'DHANUSH M',
  '61782324102038': 'DHARANIKUMAR R S',
  '61782324102039': 'DHARUN M',
  '61782324102040': 'DHIVYAA T',
  '61782324102041': 'DIVASH KALAKHETI',
  '61782324102042': 'DIVYAPPRIYA S',
  '61782324102043': 'DIVYAPRAKASH U',
  '61782324102044': 'ELACHCHANA B',
  '61782324102045': 'ELAKKIYA A',
  '61782324102046': 'ENITHA G',
  '61782324102047': 'ESSWAR RAJA V B',
  '61782324102048': 'GAYATHRI N',
  '61782324102049': 'GITASRI M',
  '61782324102050': 'GOKUL M',
  '61782324102051': 'GOPIKA M',
  '61782324102052': 'GOWSIGAR D',
  '61782324102053': 'GRISHMA SHIWAKOTI',
  '61782324102054': 'GURUNADHAN K',
  '61782324102055': 'GURUNATH S R',
  '61782324102056': 'HARIDHARSAN I K',
  '61782324102057': 'HARIDHARSHINI M K',
  '61782324102058': 'HARIHARAN V',
  '61782324102059': 'HARINI S',
  '61782324102060': 'HARINI SRI P S',
  '61782324102061': 'HARINISHREE R',
  '61782324102062': 'HARIPRIYAN S S',
  '61782324102064': 'HARISH JAYA SURYA L',
  '61782324102065': 'HARRISON BENNETT J',
  '61782324102066': 'HAYAGREEVAR G',
  '61782324102067': 'HEMAMALINI S',
  '61782324102068': 'HEMAVARSHINI R',
  '61782324102069': 'HIMANSHU BISHWAS KHAWAS',
  '61782324102070': 'JAGADESH CHANDRA BOSE K',
  '61782324102071': 'JAGATHAMILAN J J',
  '61782324102072': 'JAIPRASANNA R K',
  '61782324102073': 'JANUSHREE S',
  '61782324102074': 'JAVITH J',
  '61782324102075': 'JAYASREE D',
  '61782324102076': 'JAYAVARSHINI M N',
  '61782324102077': 'JAYAVIGNESH S A',
  '61782324102078': 'JEEVA SRI G',
  '61782324102079': 'JEEVADHARSHINI N',
  '61782324102080': 'JEEVARAMAN J M',
  '61782324102081': 'JENIFER M',
  '61782324102082': 'JESIN FRANKLIN S',
  '61782324102083': 'JUHI JUNAFER N A',
  '61782324102084': 'KANISHKA A K',
  '61782324102086': 'KIRANRAJ K R',
  '61782324102087': 'KIRUBAKARAN M',
  '61782324102088': 'KIRUBHASREE G',
  '61782324102089': 'KISHORE GANESHKUMAR',
  '61782324102090': 'KUMARESAN B',
  '61782324102091': 'LOGESH S P',
  '61782324102092': 'LOGU KUMAR G',
  '61782324102093': 'LOHITH S',
  '61782324102094': 'MAHALAKSHMI R',
  '61782324102095': 'MAIVIZHI P',
  '61782324102096': 'MALATHY S',
  '61782324102097': 'MANIKANDAN K',
  '61782324102098': 'MANIKANDAN K N',
  '61782324102099': 'MANIKANDAN V',
  '61782324102100': 'MANISH KUMAR MAHATO',
  '61782324102101': 'MANJUSHREE V',
  '61782324102102': 'MANOJ A',
  '61782324102103': 'MEHAVARSHINI S',
  '61782324102104': 'MEKALA M',
  '61782324102105': 'MOHAMAD SAMIR ALAM',
  '61782324102106': 'MOHAMMED FAROOQ N',
  '61782324102107': 'MOHITHA S',
  '61782324102108': 'MOULIKA M',
  '61782324102109': 'MOUNIYA R',
  '61782324102110': 'MOURIYA A P',
  '61782324102111': 'MRITYUNJAY PRASAD CHAURASIYA',
  '61782324102112': 'MUHAMMAD AFRITH D',
  '61782324102113': 'MUHAMMAD KAMEEL A',
  '61782324102114': 'MUKESH M',
  '61782324102115': 'MUTHUKUMARAN V',
  '61782324102116': 'NANDHINI A',
  '61782324102117': 'NAVEEN S',
  '61782324102118': 'NAVINKUMAR  P',
  '61782324102119': 'NEHAL K S',
  '61782324102120': 'NIKSHITHA  V',
  '61782324102121': 'NIRENJANA N K',
  '61782324102122': 'NISHA A',
  '61782324102123': 'NITHESH S',
  '61782324102124': 'NITHIN SAAI C S',
  '61782324102125': 'NITHYASUBHA V',
  '61782324102126': 'NIVASINI V M',
  '61782324102127': 'PAPPU KUMAR THAKUR',
  '61782324102128': 'PAULEBINEEZER M',
  '61782324102129': 'PAVITHRA P',
  '61782324102130': 'PERARULAALAN T G',
  '61782324102131': 'PETER JACOB',
  '61782324102132': 'POOJA S',
  '61782324102133': 'PRABHANJANA A T',
  '61782324102134': 'PRADEEP KUMAR S',
  '61782324102135': 'PRAJJAWAL KUNWAR',
  '61782324102136': 'PRAVEENBABU E S',
  '61782324102137': 'PRAWIN KRISHNAN G',
  '61782324102138': 'PREETHA ROSE A',
  '61782324102139': 'PRIYADARSINI R',
  '61782324102140': 'PRIYADHARSHINI V',
  '61782324102141': 'PRIYANKA S',
  '61782324102142': 'RAGINEE DEO',
  '61782324102143': 'RAGUL R',
  '61782324102144': 'RAM KISHAN SUNAR',
  '61782324102145': 'RAMESH R',
  '61782324102146': 'RATHEESH J J',
  '61782324102147': 'RITHIKA S',
  '61782324102148': 'RITHIKA SRI K',
  '61782324102149': 'ROHINI PRIYA V',
  '61782324102150': 'ROHITH S',
  '61782324102151': 'ROOPANI B',
  '61782324102152': 'ROSHNNI S B',
  '61782324102153': 'RUMESH BALAJI S',
  '61782324102154': 'SAKTIKRITHIC K K',
  '61782324102155': 'SAMIR ANSARI',
  '61782324102156': 'SAMUVEL A',
  '61782324102157': 'SANDHIYA S',
  '61782324102158': 'SANDIP SAH TURHA',
  '61782324102159': 'SANJAY KUMAR U',
  '61782324102160': 'SANJAY RAJ S',
  '61782324102161': 'SANJAY S',
  '61782324102162': 'SANJAYRAJ R',
  '61782324102163': 'SANJIT THAKUR HAJAM',
  '61782324102164': 'SANTANU MUKHIYA BIN',
  '61782324102165': 'SARAN S',
  '61782324102166': 'SARANYA M',
  '61782324102167': 'SARMILA M',
  '61782324102168': 'SENTHURVELAN K C',
  '61782324102169': 'SHALENE R',
  '61782324102170': 'SHANMATHI R G',
  '61782324102171': 'SHARMILA R',
  '61782324102172': 'SHARVESH S',
  '61782324102173': 'SHARVESHVAR T R',
  '61782324102174': 'SHARWAN KUMAR MANDAL',
  '61782324102175': 'SHIVSHANKAR KUMAR JAYSAWAL',
  '61782324102176': 'SHRINIDHI D R',
  '61782324102177': 'SHRINITHAA H',
  '61782324102178': 'SHYAM KUMAR CHAURASIYA',
  '61782324102179': 'SIVABALAN P',
  '61782324102180': 'SIVABALAN S',
  '61782324102181': 'PRANAJ J',
  '61782324102182': 'SIVASRI L',
  '61782324102183': 'SOUMYA BARANWAL',
  '61782324102184': 'SOUNDARYA S',
  '61782324102185': 'SREESANTH V S',
  '61782324102186': 'SRI ABIRAMI A',
  '61782324102187': 'SRI SASIN P',
  '61782324102188': 'SRINIDHI P',
  '61782324102189': 'SRINIDHI R',
  '61782324102190': 'SRINITHIPRIYA T',
  '61782324102191': 'SRIYA S',
  '61782324102192': 'SUBASREE V',
  '61782324102193': 'SUBHASINI S A',
  '61782324102194': 'SUDARSHAN SAH',
  '61782324102195': 'SUDHARSHAN S',
  '61782324102196': 'SUDHIKSHA R',
  '61782324102197': 'SUGANTHIKA R',
  '61782324102198': 'SWATHI S',
  '61782324102199': 'SWATHY V R',
  '61782324102200': 'TARUNHARI',
  '61782324102201': 'TEKNARAYAN RAJBANSHI',
  '61782324102202': 'THARUN R K',
  '61782324102203': 'THIRUMALAI S',
  '61782324102204': 'UPENDRA KUMAR YADAV',
  '61782324102205': 'USHA A',
  '61782324102206': 'VARUNUVIPRIYA V',
  '61782324102207': 'VIDHYA P',
  '61782324102208': 'VIDHYASRI S',
  '61782324102209': 'VIGNESH KARTHIKEYAN M R',
  '61782324102210': 'VIGNESHSARAVANAN M S',
  '61782324102211': 'VISHAL KARTHIK R',
  '61782324102212': 'VISHNUPPRIYAN G',
  '61782324102213': 'YASMIN BANU S',
  '61782324102214': 'YESHWANTH P',
  '61782324102215': 'YOGESHWARAN K',
  '61782324102216': 'YOKESHWARAAN K J',
  '61782324102701': 'AKASH K',
  '61782324102702': 'SIVAPRAKASH M',
  '61782324102703': 'ANBARASU S',
  '61782324102704': 'DEEPAN RAJ A T',
  '61782324102705': 'DHATCHINAMURTHI S V',
  '61782324102706': 'KAMALIKA T',
  '61782324102707': 'KATHIRVENTHAN S',
  '61782324102708': 'KESHORE G V',
  '61782324102709': 'KISHORE K',
  '61782324102710': 'MANIKANDAN S',
  '61782324102711': 'NAVYA S',
  '61782324102713': 'AMAR FAROOK  M',
  '61782324102714': 'SABARINATHAN M',
  '61782324102715': 'G.SRI HARNI',
  '61782324111001': 'ABINAYA',
  '61782324111002': 'ADHITHYAN',
  '61782324111003': 'ADITYA CHAURASIYA',
  '61782324111004': 'AHTHI SHRI',
  '61782324111005': 'AJAY KIRTHICK',
  '61782324111006': 'AMEERUDHEEN',
  '61782324111007': 'AMURTHA',
  '61782324111008': 'ANDRICK WILLIAMS',
  '61782324111009': 'BENO JACINTH RAJ',
  '61782324111010': 'BHARANI HARI',
  '61782324111011': 'CHANDRAMATHI',
  '61782324111012': 'CHETANA BUDHA CHHETRI',
  '61782324111013': 'DEEPIKA',
  '61782324111014': 'DEV',
  '61782324111015': 'DHANASEKAR',
  '61782324111016': 'DHARMA SUGASH',
  '61782324111017': 'DHARSHANAPRIYA',
  '61782324111018': 'DHIVAGAR',
  '61782324111019': 'ELANGO',
  '61782324111020': 'GOWSHIKA',
  '61782324111021': 'HABEEBBUR RAHAMAN',
  '61782324111022': 'HARI',
  '61782324111023': 'HARIDHARUSON',
  '61782324111024': 'INDHUMATHI',
  '61782324111025': 'JAYA NITHYASRI',
  '61782324111026': 'JEFFRIN',
  '61782324111027': 'JOHITH',
  '61782324111028': 'KAARTHIKEYAN',
  '61782324111029': 'KAKARLA NIKHIL',
  '61782324111030': 'KAMALI',
  '61782324111031': 'KAMESH',
  '61782324111032': 'KANISH',
  '61782324111033': 'KRITIKA SILWA',
  '61782324111034': 'KUMKUMAKAVYASHREE',
  '61782324111035': 'LINGESH',
  '61782324111036': 'LOKESHWARAN',
  '61782324111037': 'MANIGANDANBALAJI D',
  '61782324111038': 'MEGHA J P',
  '61782324111039': 'MONIKA S',
  '61782324111040': 'MONISH R',
  '61782324111041': 'MUGANBALAJI M',
  '61782324111042': 'NAREN KARTHICK S',
  '61782324111043': 'NEHARIKHA I M',
  '61782324111044': 'NITHISH J',
  '61782324111045': 'NITHYASRI N',
  '61782324111046': 'PRAGADEESH V',
  '61782324111047': 'PRAGADEESHWARAN S',
  '61782324111048': 'PRAKASH PD YADAV',
  '61782324111049': 'PRATIGYA ADHIKARY',
  '61782324111050': 'PRIYANKA D',
  '61782324111051': 'RAAJ NIKITAA K R',
  '61782324111052': 'RAHUL KUMAR YADAV',
  '61782324111053': 'RAVIKIRAN S',
  '61782324111054': 'RISHIKESH SS',
  '61782324111055': 'RITHIK R',
  '61782324111056': 'ROHITH P',
  '61782324111057': 'ROHITH T',
  '61782324111058': 'SAMAGYA BARAL',
  '61782324111059': 'SANDHIYA CHAWLA M',
  '617823241110603': 'SANDHIYA M',
  '61782324111061': 'SARVESH P',
  '61782324111062': 'SHREE SHYAM SINHA',
  '61782324111063': 'SIVARAMAN P',
  '61782324111064': 'SRIDEVI G',
  '61782324111065': 'SRIDHARAN P',
  '61782324111066': 'SRINIVASAN M',
  '61782324111067': 'SUDHISH VIJAI',
  '61782324111068': 'SUJAN KHATRI',
  '61782324111069': 'SUJITH KUMAR M',
  '61782324111070': 'THAMARAI LAKSHMI S',
  '61782324111071': 'THARINI G',
  '61782324111072': 'VIMAL RAJ K',
  '61782324111701': 'ELAVARASAN A',
  '61782324111702': 'HARSHADRAMM J S',
  '61782324111705': 'NIVETHA V',
  '6178232411201': 'ABILASH P',
  '6178232411202': 'AJAY V',
  '6178232411203': 'ASHWIN M S',
  '6178232411204': 'ASWANTH B',
  '6178232411205': 'DEEPAK P',
  '6178232411206': 'DHARANIK',
  '6178232411207': 'DHURGAD EVI S',
  '6178232411208': 'DIVYA A',
  '6178232411209': 'ELA VIBUSHA',
  '6178232411210': 'ELANKUMARAN M S',
  '6178232411211': 'GOKUL R',
  '6178232411212': 'GOPINATH V',
  '6178232411213': 'HARI RAJ B',
  '6178232411214': 'JAGATH PRIYAN V',
  '6178232411215': 'JAISRI S',
  '6178232411216': 'JENITHRAJ R',
  '6178232411217': 'KALAIYARASI D',
  '6178232411218': 'KAMALI S',
  '6178232411219': 'KAVEENA M',
  '6178232411220': 'KAVYA S',
  '6178232411221': 'KIRANKUMAR M',
  '6178232411222': 'KIRUTHI VARSHNI S',
  '6178232411223': 'MADHUMITA SP',
  '6178232411224': 'MALATHI G',
  '6178232411225': 'MOHAMMED MUZAMMIL A',
  '6178232411226': 'MONISH ESHWAR S',
  '6178232411227': 'MONISHREE K',
  '6178232411228': 'NAFEES TAJ M',
  '6178232411229': 'NAVEENKUMAR K',
  '6178232411230': 'NETHRA G',
  '6178232411231': 'NIRANJANA E',
  '6178232411232': 'NIRMAL KUMAR V',
  '6178232411233': 'PERAPASU K',
  '6178232411234': 'POOJA M',
  '6178232411235': 'POOJASHREE B',
  '6178232411236': 'POORNASRI V',
  '6178232411237': 'PRADEEP D',
  '6178232411238': 'PRIYAN K',
  '6178232411239': 'RAHINI K',
  '6178232411240': 'RISHIPRIYAN M',
  '6178232411241': 'ROSHAN D',
  '6178232411242': 'SANJAI K',
  '6178232411243': 'SANJAI Y',
  '6178232411244': 'SANJAY G',
  '6178232411245': 'SANJAY R',
  '6178232411246': 'SASSWANTH R',
  '6178232411247': 'SATHASIVAM S',
  '6178232411248': 'SHARVESH K S',
  '6178232411249': 'SREENANDHA S',
  '6178232411250': 'SRINITH B',
  '6178232411251': 'SUBASRI K',
  '6178232411252': 'SUBASHREE D',
  '6178232411253': 'SUBHIKSHA N',
  '6178232411254': 'SURIYA S',
  '6178232411255': 'SURYA B',
  '6178232411256': 'SURYA V',
  '6178232411257': 'SWATHI S',
  '6178232411258': 'THAMODHARAN A',
  '6178232411259': 'THARUN KRISHNA S',
  '6178232411260': 'THIRUMURUGAN P',
  '6178232411261': 'TUMIL N',
  '6178232411262': 'UMAIRA S',
  '6178232411263': 'WASEEM AHAMED S',
  '61782324112701': 'MUHAMMED BASHEER AHMED',
  '61782324112702': 'SRIGURU K R',
  '61782324112703': 'YOGESWARAN K',
  '61783323102703': 'DHARANEESHKAR R',
};


const SONACSE_STUDENTS_FIRST = {
  '25AMLBE002': 'DINESH S',
  '25AMLBE003': 'JAGAN NISANTH M',
  '25AMLBE004': 'SARWAJITH S N',
  '25AMLBE006': 'INDHUJA S',
  '25AMLBE011': 'SHARMILA DEVI J',
  '25AMLBE014': 'HARIPRASATH P',
  '25AMLBE017': 'SUJAY PRANAV V',
  '25AMLBE018': 'HARIHARAN C',
  '25AMLBE019': 'FAREEN I',
  '25AMLBE020': 'SANTHOSH KUMAR S',
  '25AMLBE035': 'LOSHITHA J',
  '25AMLBE041': 'NIHAREKHA S S',
  '25AMLBE043': 'RAKSHITA G R',
  '25AMLBE044': 'VAISHNAVI M',
  '25AMLBE045': 'SHOHITH D',
  '25AMLBE046': 'DHARSHINI S',
  '25AMLBE047': 'SANJANA R',
  '25AMLBE048': 'NAREN KARTHI P',
  '25AMLBE049': 'BARATH S J',
  '25AMLBE050': 'ARAVINDAN N',
  '25AMLBE051': 'ISHANA G P',
  '25AMLBE054': 'DHARUN KUMAR V',
  '25AMLBE055': 'MOHAMMED SAMMER M',
  '25AMLBE056': 'ANAGHA NAIR',
  '25AMLBE057': 'SHRAVANI MAHESH KADAM',
  '25AMLBE058': 'SWETHA G',
  '25AMLBE059': 'SANMITHA S',
  '25AMLBE060': 'TULASI U',
  '25AMLBE061': 'SREE KHANISHKHA T',
  '25AMLBE062': 'PAKYALA LUKHITH',
  '25AMLBE063': 'NIYAM KUMAR JAIN',
  '25AMLBE064': 'ARPUTHA RAJ',
  '25AMLBE065': 'SURYES WARAN V',
  '25AMLBE066': 'AMIRTHAVARSHINI P',
  '25AMLBE067': 'NIKESH S',
  '25AMLBE068': 'BHARANI KUMAR K',
  '25AMLBE069': 'SUDHARSANA PRIYAN P',
  '25AMLBE070': 'ATCHAYA S',
  '25AMLBE071': 'VASANTH R',
  '25AMLBE072': 'SOUNDARYA P',
  '25AMLBE073': 'GURUPRASAD S',
  '25AMLBE074': 'GAYATHIRI V',
  '25AMLBE075': 'JEEVAN S',
  '25AMLBE076': 'MANIKANDAN K V',
  '25AMLBE077': 'DHAMODHARAN K',
  '25AMLBE078': 'HARINI K',
  '25AMLBE079': 'ARAVIND S M',
  '25AMLBE080': 'RITISHA M',
  '25AMLBE081': 'SUSHMITHA K',
  '25AMLBE082': 'SHAMRUTHA SHANTHA KUMAR',
  '25AMLBE083': 'ABINAV SURESHKUMAR',
  '25AMLBE084': 'SUGAVANESWARAN A',
  '25AMLBE085': 'HARINI V',
  '25AMLBE086': 'PAVAN KUMAR S R',
  '25AMLBE087': 'VIDHYA R',
  '25AMLBE088': 'MEGANATH M',
  '25AMLBE089': 'GOKUL S',
  '25AMLBE090': 'MANISHA M',
  '25AMLBE091': 'MONISH A S',
  '25AMLBE092': 'KIZRATAJ S',
  '25AMLBE093': 'NIGASHINI D',
  '25AMLBE094': 'VENMATHI M',
  '25AMLBE095': 'SHEIK MOHAMMED ARMAAN A',
  '25AMLBE096': 'HARIHARAN T',
  '25AMLBE097': 'GOKUL J',
  '25AMLBE098': 'SUSMITHA S',
  '25AMLBE099': 'SUJITHA G',
  '25AMLBE100': 'MUGUNDHAN S K',
  '25AMLBE101': 'KEERTHANA K',
  '25AMLBE102': 'SIVAJIVASAN S',
  '25AMLBE103': 'KEERTHANAA N',
  '25AMLBE104': 'GIRIHARAN A',
  '25AMLBE105': 'MUKILAN M',
  '25AMLBE106': 'VISHNU G',
  '25AMLBE107': 'SREELAYA G',
  '25AMLBE108': 'DHEEPSHIKA B',
  '25AMLBE109': 'POOJA SHREE A',
  '25AMLBE110': 'BIKRAM RAJBANSHI',
  '25AMLBE111': 'ARYAN AYDI',
  '25AMLBE112': 'NAVEENA KUMARI R',
  '25AMLBE113': 'PRADEEP P',
  '25AMLBE114': 'AKASH S',
  '25AMLBE115': 'SREESHA R',
  '25AMLBE116': 'ARSHATH A',
  '25AMLBE117': 'ACHYUT MANI RISAL',
  '25AMLBE118': 'YOG RAJ DEV',
  '25AMLBE119': 'MILAN RAJ JOSHI',
  '25AMLBE120': 'MADHUMITHA T',
  '25AMLBE121': 'KANISHKA D',
  '25AMLBE122': 'HARISH B',
  '25AMLBE123': 'SHERYL OPHELIA R',
  '25AMLBE124': 'JAYAMALAR V',
  '25AMLBE125': 'SAKTHI PRIYAN M',
  '25AMLBE126': 'GOKULNAATH S',
  '25AMLBE127': 'NISHALINI M',
  '25CBEBE002': 'ABIRAMI V S',
  '25CBEBE008': 'NITHYAA SHREE S',
  '25CBEBE019': 'TRINETRA S',
  '25CBEBE020': 'YAZHINI R',
  '25CBEBE021': 'ELAYABOOPATHI T',
  '25CBEBE022': 'DINESH S P',
  '25CBEBE024': 'HARITHA D',
  '25CBEBE026': 'ANUSHRI M',
  '25CBEBE028': 'SHRIHARI S',
  '25CBEBE029': 'KENNETH LAMBART D',
  '25CBEBE030': 'RICHA S',
  '25CBEBE032': 'KENISHA R',
  '25CBEBE033': 'AAKASH S',
  '25CBEBE034': 'JOSHNA ASHLYN J',
  '25CBEBE035': 'DURGESH S.K',
  '25CBEBE037': 'SRI AISHVARYAN P K',
  '25CBEBE044': 'KABILESH K',
  '25CBEBE045': 'ANU GAYATHRI N',
  '25CBEBE046': 'NATHIKA M',
  '25CBEBE047': 'POOJAMBIKAI R',
  '25CBEBE048': 'HARIKISHOR R',
  '25CBEBE049': 'THIRUKUMARAN P',
  '25CBEBE050': 'DHANAKUMARAN J',
  '25CBEBE051': 'PRAVINKUMAR S',
  '25CBEBE052': 'GURUBALAJI S',
  '25CBEBE053': 'NIVASH K',
  '25CBEBE054': 'DEEPAK R',
  '25CBEBE055': 'THARSHINI J P',
  '25CBEBE056': 'YOKESH NARAYAN S',
  '25CBEBE057': 'MADESH B',
  '25CBEBE058': 'NIVETHA V',
  '25CBEBE059': 'SADHANA SJ',
  '25CBEBE060': 'THIRUPPATHI U',
  '25CBEBE061': 'VIVEKA A',
  '25CBEBE062': 'FOUZUL HIDHAYA H',
  '25CBEBE063': 'INBASEKARAN K',
  '25CBEBE064': 'KESAVAN R',
  '25CBEBE065': 'VARNIKA LAKSHMI R',
  '25CBEBE066': 'JAISURYA M J',
  '25CBEBE067': 'NARESH PRIYAN R',
  '25CBEBE068': 'SUNDARAGANESAN S',
  '25CBEBE069': 'AJITHRA N',
  '25CBEBE070': 'LOCHANA SRI J',
  '25CBEBE071': 'SRIAKASH S',
  '25CBEBE072': 'AAKASH G',
  '25CBEBE073': 'LINGESHWARAN S',
  '25CBEBE074': 'KIRTHANA N',
  '25CBEBE075': 'PRAVIN U',
  '25CBEBE076': 'HEERA S R',
  '25CBEBE077': 'DISHA D',
  '25CBEBE078': 'MADAVAN S',
  '25CBEBE079': 'KAVIYA V',
  '25CBEBE080': 'URJEETA A R',
  '25CBEBE081': 'RITHIKA V',
  '25CBEBE083': 'PRIYADHARSHINI R',
  '25CSDBE001': 'DUSHYANTH S K',
  '25CSDBE002': 'DIYAA TEJASSWINI S',
  '25CSDBE006': 'ROSHINI K',
  '25CSDBE010': 'VIGNESHWAR M',
  '25CSDBE012': 'SANJAY P J',
  '25CSDBE015': 'LOKESH G',
  '25CSDBE017': 'KAVINRAJ E',
  '25CSDBE019': 'ROSHITHA S',
  '25CSDBE022': 'DIVYA SHREE M',
  '25CSDBE025': 'VIKASPRANAV M P',
  '25CSDBE026': 'ABRAR AHAMED S',
  '25CSDBE027': 'KANISHKA S.S',
  '25CSDBE028': 'SRIDHAR T',
  '25CSDBE029': 'NIRESH S',
  '25CSDBE030': 'MEDHA M',
  '25CSDBE032': 'SIVAKARTHIKEYAN R',
  '25CSDBE034': 'PRITHIVIRAJ R S',
  '25CSDBE037': 'SRUTHIKA M',
  '25CSDBE038': 'DEEPIKA S',
  '25CSDBE039': 'KEERTHANA S',
  '25CSDBE040': 'BALA MURUGAN S',
  '25CSDBE041': 'VIKASHINI S',
  '25CSDBE042': 'ELAVARASAN M',
  '25CSDBE043': 'YOGAPRADAKSHINA A',
  '25CSDBE044': 'MANO S',
  '25CSDBE045': 'THIRUMOORTHY S',
  '25CSDBE046': 'PRAVEEN M',
  '25CSDBE047': 'JANANI M',
  '25CSDBE048': 'ARYA S V',
  '25CSDBE050': 'HEMANTH S',
  '25CSDBE051': 'RITIKA S',
  '25CSDBE052': 'ASHVIKA S R',
  '25CSDBE053': 'SANTHOSH M',
  '25CSDBE054': 'KAVITHA M',
  '25CSDBE055': 'RASEENA R',
  '25CSDBE056': 'PUJHAA SRINITEE S',
  '25CSDBE057': 'SIRISHA S',
  '25CSDBE060': 'THARUN N',
  '25CSDBE061': 'DHARINEESH P R',
  '25CSDBE062': 'SANDHIYA P',
  '25CSDBE063': 'TEHJAASVARTANAN S',
  '25CSDBE064': 'THIRUNISHANTH I',
  '25CSDBE065': 'MANISHAA K',
  '25CSDBE066': 'KANNAN T',
  '25CSDBE067': 'BASIMA PARVEEN J',
  '25CSDBE068': 'RAMPRASANTH S',
  '25CSDBE069': 'KEERTHANA S',
  '25CSDBE070': 'DEEPIKA V',
  '25CSDBE071': 'SHARATH RAJKUMAR',
  '25CSDBE072': 'PRIYA VADHANA U P',
  '25CSDBE073': 'RUBAN K',
  '25CSDBE074': 'DIVAGER R',
  '25CSDBE075': 'SIVAPUGALVAN J',
  '25CSDBE076': 'MANEESHA M',
  '25CSDBE077': 'SANDHVANA P S',
  '25CSDBE078': 'MONIKA C',
  '25CSDBE079': 'SHIVAGOKUL S V',
  '25CSDBE080': 'JAGATHISH C',
  '25CSDBE081': 'GAYATHTHIRI P',
  '25CSDBE082': 'RAGHU M',
  '25CSDBE083': 'NATHIYA A R',
  '25CSDBE084': 'SRISARVESH J',
  '25CSEBE003': 'PRAJITH P',
  '25CSEBE009': 'DHANANJAYAN A V',
  '25CSEBE010': 'ARAVIND K B',
  '25CSEBE012': 'KELVIN MAMMEN M',
  '25CSEBE015': 'MOHAMMAD ZUNAITH A',
  '25CSEBE020': 'HARINI R',
  '25CSEBE021': 'RAKSHITHA S',
  '25CSEBE023': 'DHIVYASREE M',
  '25CSEBE025': 'SIBI SAKTHI S',
  '25CSEBE029': 'MITHUN MUKESH K M',
  '25CSEBE030': 'NAREN VENKAAT U G',
  '25CSEBE031': 'NAKSHATRA U G',
  '25CSEBE032': 'SRIRAMGURU V J',
  '25CSEBE033': 'MONIKA S',
  '25CSEBE034': 'OBU HARINI O',
  '25CSEBE035': 'DHARANI PRIYA A V',
  '25CSEBE038': 'NIRANJAN B A',
  '25CSEBE044': 'TUHAAJASY M',
  '25CSEBE047': 'SUJITHKUMAR M',
  '25CSEBE048': 'KANISHKA S',
  '25CSEBE051': 'SOORIYA PRABHA K',
  '25CSEBE053': 'VARUN V',
  '25CSEBE057': 'NIHALL KUMAR M',
  '25CSEBE065': 'JANASHRI N V',
  '25CSEBE066': 'SAMRITHA S',
  '25CSEBE072': 'PRADHISHA S',
  '25CSEBE080': 'THARUNKUMAR M',
  '25CSEBE083': 'NIRANJANA A',
  '25CSEBE084': 'VAISHNAVI D',
  '25CSEBE086': 'SRIJA R',
  '25CSEBE099': 'CHITHIEIS A P',
  '25CSEBE101': 'AADHITHYA NARAYANAN C',
  '25CSEBE105': 'GOKUL KRISNAN C',
  '25CSEBE113': 'YOGAPRIYA V',
  '25CSEBE114': 'RAKSHITHA S',
  '25CSEBE124': 'PAVATHARANI R G',
  '25CSEBE125': 'SELVAABIRAMI S',
  '25CSEBE126': 'PREETHI T',
  '25CSEBE127': 'KARUNIKA C',
  '25CSEBE128': 'SURIYA R',
  '25CSEBE129': 'YASHWIKA S',
  '25CSEBE130': 'KAPIL KANNA S',
  '25CSEBE131': 'AMBRESHH R A',
  '25CSEBE132': 'MAHATHI SHRI S V',
  '25CSEBE133': 'THANUJA ANIL PADATARE',
  '25CSEBE135': 'THAKSHIN RAJAN S.B',
  '25CSEBE136': 'LOGANATHAN P',
  '25CSEBE138': 'PRATHAP M',
  '25CSEBE139': 'NETHRA P R',
  '25CSEBE140': 'HARI EASWAR V',
  '25CSEBE141': 'RINTHIYA A S',
  '25CSEBE142': 'KANISHK R',
  '25CSEBE143': 'JAYANTH J',
  '25CSEBE144': 'GAYATHRI S A',
  '25CSEBE147': 'KAVIN M',
  '25CSEBE150': 'SARAN B',
  '25CSEBE152': 'JANANI K',
  '25CSEBE153': 'SHEIK SAMEER S',
  '25CSEBE155': 'ISHARUTHIGA T M',
  '25CSEBE157': 'SABARIMURUGAN S',
  '25CSEBE159': 'SABARI V',
  '25CSEBE160': 'PRAVEEN S',
  '25CSEBE161': 'ANANDITHA RANGASAMY',
  '25CSEBE163': 'DEVI K',
  '25CSEBE164': 'KAYALNETHRA S',
  '25CSEBE165': 'INJMAMUL HAK M D',
  '25CSEBE166': 'VASUNDRA M',
  '25CSEBE168': 'SAFRIN A',
  '25CSEBE169': 'PRETESH S',
  '25CSEBE170': 'VANSHIKA JAIN R',
  '25CSEBE171': 'NANDHANA P',
  '25CSEBE172': 'VASHUNDTHERA S',
  '25CSEBE173': 'GANESH B',
  '25CSEBE174': 'INIYAMOZHI J',
  '25CSEBE175': 'KRISHNAN P',
  '25CSEBE176': 'KISHOR KUMAR J',
  '25CSEBE178': 'TAMILARASU D',
  '25CSEBE179': 'SABARIVASAN T',
  '25CSEBE180': 'PRANIKKA R',
  '25CSEBE181': 'KAVYA M',
  '25CSEBE182': 'SOWNDHARYA K',
  '25CSEBE183': 'KAUSHIK S',
  '25CSEBE184': 'MAGHASHREE S',
  '25CSEBE185': 'ANGULAKSHMI T',
  '25CSEBE186': 'KABILAN R',
  '25CSEBE187': 'KALAIYARASI J',
  '25CSEBE188': 'NITHEESH S',
  '25CSEBE190': 'THARUN K S',
  '25CSEBE191': 'ANBUMANI B',
  '25CSEBE192': 'ANITHA R',
  '25CSEBE193': 'ARUL KUMARAN S',
  '25CSEBE194': 'KARTHICK S',
  '25CSEBE195': 'HARITHRA E',
  '25CSEBE196': 'JAYASHAKTHI K',
  '25CSEBE197': 'KAVIYAN S S',
  '25CSEBE198': 'HARINI S',
  '25CSEBE199': 'HARINI V',
  '25CSEBE200': 'SAKTHIVEL V',
  '25CSEBE201': 'SABITHA S',
  '25CSEBE202': 'PRITHIKA R S',
  '25CSEBE203': 'HARINI S',
  '25CSEBE204': 'NANDHINI C',
  '25CSEBE205': 'SUGAVANESH R A',
  '25CSEBE206': 'RAAJESHVAR S R',
  '25CSEBE207': 'VARNIKASHREE K P',
  '25CSEBE208': 'KARTHICK SELVA V',
  '25CSEBE209': 'VARUNASRI S',
  '25CSEBE210': 'SWATHY P',
  '25CSEBE211': 'ARCHANA S',
  '25CSEBE212': 'NISHANTH S',
  '25CSEBE213': 'SUDHARSHAN D',
  '25CSEBE214': 'SATHANA M',
  '25CSEBE215': 'SASMITHA R',
  '25CSEBE216': 'SUSHMITHA V',
  '25CSEBE217': 'DHANUSRI S',
  '25CSEBE218': 'NOWFALLALI M',
  '25CSEBE219': 'JEEVANANTHAM A',
  '25CSEBE220': 'YOGA SRI S',
  '25CSEBE221': 'VIBASHINI S',
  '25CSEBE222': 'ARIKARAN S',
  '25CSEBE223': 'MOHAMED SHOHIL A',
  '25CSEBE224': 'DHARANI M',
  '25CSEBE225': 'MIRUNALINI M',
  '25CSEBE226': 'SHIVAGNAANA SUNDARAN K P',
  '25CSEBE227': 'OM KUMAR SINGH',
  '25CSEBE228': 'SIRAJ AHAMED J',
  '25CSEBE229': 'RITHIGA A',
  '25CSEBE230': 'VISHNUVIKAS R',
  '25CSEBE231': 'VENU MADHAW K',
  '25CSEBE232': 'ABINAYA R A',
  '25CSEBE233': 'THIRUMALBHARATHI S',
  '25CSEBE234': 'NANDHINI V',
  '25CSEBE235': 'DELITTA RAJ S',
  '25CSEBE236': 'SASMITHA R',
  '25CSEBE237': 'NARMAATHA S',
  '25CSEBE238': 'SUPRIYA M',
  '25CSEBE239': 'SAM GLADSON A',
  '25CSEBE240': 'SABARINATHAN R',
  '25CSEBE241': 'POORANI B D',
  '25CSEBE242': 'SURIYAH M',
  '25CSEBE243': 'SANTHOSH R',
  '25CSEBE244': 'ROHITHKUMAR P',
  '25CSEBE245': 'ARUNRAJ G',
  '25CSEBE246': 'ASHIKA V',
  '25CSEBE247': 'RAJESH S S',
  '25CSEBE248': 'KEERTHANA S',
  '25CSEBE249': 'RESHMA MEERA',
  '25CSEBE250': 'DHARANEESH M R',
  '25CSEBE251': 'PRASANNA S D',
  '25CSEBE252': 'SOWBIGASRI S',
  '25CSEBE253': 'LINGESHWARAN A',
  '25CSEBE254': 'MOHAMED HADIL S',
  '25CSEBE255': 'MEGALA V',
  '25CSEBE256': 'SUBHASHINI U',
  '25CSEBE257': 'KAVIYA M',
  '25CSEBE258': 'ARAVIND R',
  '25CSEBE259': 'ARSHATH RAHAMAAN KAVERIPATTINAM AYUBKHAN RISWANA',
  '25CSEBE260': 'KAVIYARASAN A',
  '25CSEBE261': 'VIGNESH T',
  '25CSEBE263': 'VIMAL V',
  '25CSEBE264': 'LAKSHAN G M',
  '25CSEBE265': 'KAMALI R',
  '25CSEBE266': 'KOKILA MITHIRAN M C',
  '25CSEBE267': 'SHARVITHAA RAHINI R',
  '25CSEBE268': 'RAGULNATH G',
  '25CSEBE269': 'HARINI D',
  '25CSEBE270': 'PREETHI SASI S',
  '25CSEBE271': 'JERCY PRECILLA B',
  '25CSEBE272': 'DEEPSHIKA N',
  '25CSEBE273': 'SHRI HARISH T',
  '25CSEBE274': 'NITHISH R M',
  '25CSEBE276': 'VIDHYATHARAN K R',
  '25CSEBE277': 'DIWAGAR G K',
  '25CSEBE278': 'SWATHI T',
  '25CSEBE279': 'JAISHREE M',
  '25CSEBE280': 'RAHUL PATEL',
  '25CSEBE281': 'SANDHYA YADAV',
  '25CSEBE282': 'SATYAM CHAURASIYA',
  '25CSEBE283': 'MENIKA KUMARI TIWARI',
  '25CSEBE284': 'RABI MISHRA',
  '25CSEBE285': 'SUSMITA TRIPATHI',
  '25CSEBE286': 'ANSH RAJ TIWARI',
  '25CSEBE287': 'DHANANJAY RAJ TIWARI',
  '25CSEBE288': 'KHEM NARAYAN CHAUHAN',
  '25CSEBE289': 'AGALYA M',
  '25CSEBE290': 'NANDHINI V',
  '25CSEBE291': 'KANISHKA S',
  '25CSEBE292': 'STAM BC',
  '25CSEBE293': 'ANISHA SHIWAKOTI',
  '25CSEBE294': 'PRASANTA WAIBA',
  '25CSEBE295': 'RAMU PRASAD PATEL',
  '25CSEBE296': 'NIRANJAN SAH',
  '25CSEBE297': 'LOHITHA B',
  '25CSEBE298': 'RAJESH KUMAR MAHATO',
  '25CSEBE299': 'ABINAYA R',
  '25CSEBE300': 'INBARASAN D',
  '25CSEBE301': 'DHARSHINI V',
  '25CSEBE302': 'JEEVAN N',
  '25CSEBE303': 'LAKSHITHA B',
  '25CSEBE304': 'NITHIN N',
  '25CSEBE305': 'POOVARASI S',
  '25CSEBE307': 'ARAYANA R',
  '25CSEBE308': 'ALAGU VELAVAN M',
  '25CSEBE309': 'BASOV ROY B',
  '25CSEBE310': 'HEAMANTH KUMAR K M',
  '25CSEBE311': 'DEVI BALA S',
  '25CSEBE312': 'DHIVYA DHARSHINI P',
  '25CSEBE313': 'SUBHA SHREE R',
  '25SCEBE001': 'MADHAVAN M',
  '25SCEBE003': 'AMREEN BANU F',
  '25SCEBE005': 'EZHIL KUMARAN I',
  '25SCEBE006': 'VALLARASU A',
  '25SCEBE007': 'KAMALESH S V',
  '25SCEBE009': 'SARVESH M S',
  '25SCEBE011': 'RAMYA M',
  '25SCEBE013': 'KIRUTHIKA SRI R',
  '25SCEBE014': 'NITHISH M',
  '25SCEBE017': 'ASHWELL A',
  '25SCEBE020': 'GOWMIKA K',
  '25SCEBE022': 'VAISHNAVI G',
  '25SCEBE028': 'JANISHAA G',
  '25SCEBE031': 'PRIYA DHARSHINI S',
  '25SCEBE032': 'JENISHA A',
  '25SCEBE033': 'MANASHA S',
  '25SCEBE035': 'ABINANDHAN R',
  '25SCEBE037': 'KUJALARAJAN V',
  '25SCEBE038': 'HARISHANKAR A S',
  '25SCEBE039': 'MOHAMED ALHASIR S',
  '25SCEBE041': 'GOKULRAJ U',
  '25SCEBE044': 'SURYA SHREE T',
  '25SCEBE045': 'RAJARAJESHWARI J',
  '25SCEBE046': 'KHAVENA SREE D',
  '25SCEBE047': 'VISHAL V',
  '25SCEBE048': 'KALAIYARASAN V',
  '25SCEBE049': 'KIRUTHIKA M',
  '25SCEBE051': 'PRADEEP V',
  '25SCEBE052': 'ARUL JONES D',
  '25SCEBE053': 'GOKUL S',
  '25SCEBE054': 'JAIDEEP S',
  '25SCEBE055': 'RAMYA S',
  '25SCEBE056': 'SHALINI K',
  '25SCEBE057': 'HARIHARAN G K',
  '25SCEBE058': 'ARJUN B',
  '25SCEBE059': 'KARISHMA I',
  '25SCEBE060': 'DHARSHINI A',
  '25SCEBE061': 'RAJKUMAR N',
  '25SCEBE062': 'MAHENDRAAPRABHU A',
  '25SCEBE063': 'JYOTSANA S',
  '25SCEBE064': 'MEENAKSHI G',
  '25SCEBE065': 'BRINTHA D',
  '25SCEBE066': 'MITHRASHREE M',
  '25SCEBE067': 'NISHA R',
  '25SCEBE068': 'YUGASHREE S',
  '25SCEBE069': 'DHAARINIKASRI T',
  '25SCEBE070': 'ROSHINI P',
  '25SCEBE071': 'SAKTHIVEL M',
  '25SCEBE072': 'MOHAMED YAZIR L',
  '25SCEBE073': 'VISHAAL S',
  '25SCEBE074': 'SOUNDHARYA J',
  '25SCEBE075': 'NIKITHA K.V',
  '25SCEBE076': 'MAIYARASAN T',
  '25SCEBE077': 'SAKTHI PARAMESWAR P',
  '25SCEBE078': 'SATHISH KUMAR S',
  '25SCEBE079': 'BOOMIKA P',
  '25SCEBE080': 'SUREKA M J',
  '25SCEBE081': 'SADHANA T',
  '25SCEBE082': 'SALAMAN S',
  '25SCEBE083': 'DHANUSH K',
  '25SCEBE084': 'SUPRIYA S',
  '25SCEBE085': 'ATCHAYA M V',
  '25SCEBE086': 'KISHORE KUMAR V'
};

fastify.post('/api/sonacse/register', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. FAST VALIDATION - Simplified
    const { roll_number, email, phone, year_of_study, gender, workshop_selections = [], event_selections = [] } = request.body;
    
    if (!roll_number) throw new Error('VALIDATION_FAILED: Roll number required');
    if (!email || !email.includes('@')) throw new Error('VALIDATION_FAILED: Valid email required');
    if (!phone || phone.replace(/\D/g, '').length < 10) throw new Error('VALIDATION_FAILED: Valid phone required');
    
    const year = parseInt(year_of_study);
    if (![1,2,3,4].includes(year)) throw new Error('VALIDATION_FAILED: Year must be 1-4');
    
    // 2. CHECK STUDENT - Single lookup
    const cleanRoll = roll_number.trim().toUpperCase();
    let studentName = SONACSE_STUDENTS_FIRST[cleanRoll] || SONACSE_STUDENTS[cleanRoll];
    let isFirstYear = !!SONACSE_STUDENTS_FIRST[cleanRoll];
    
    if (!studentName) throw new Error('INVALID_SONACSE_ROLL: Roll number not found');
    
    // 3. CHECK DEADLINE
    if (moment().isAfter(moment(EVENT_DATES.registration_closes))) {
      throw new Error('REGISTRATION_CLOSED');
    }
    
    // 4. CHECK DUPLICATE EMAIL
    const existing = await client.query('SELECT 1 FROM participants WHERE LOWER(email)=LOWER($1)', [email]);
    if (existing.rows.length > 0) throw new Error('EMAIL_EXISTS');
    
    // 5. CALCULATE AMOUNT - Fast calculation
    const eventCount = event_selections.length;
    const workshopCount = workshop_selections.length;
    
    const eventsAmount = eventCount === 0 ? 0 : 
      year === 1 ? Math.max(0, (eventCount * 25) - 50) : 
      year >= 2 ? 0 : eventCount * 25;
    
    const workshopsAmount = workshopCount * 300; // ₹300 after discount
    const totalAmount = eventsAmount + workshopsAmount;
    const needsPayment = workshopsAmount > 0;
    
    // 6. INSERT PARTICIPANT
    const participant = await client.query(
      `INSERT INTO participants (full_name, email, phone, college_name, department, year_of_study, gender) 
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING participant_id`,
      [studentName, email.toLowerCase(), phone.replace(/\D/g,''), 
       'Sona College of Technology (SONACSE)', 'CSE', year, gender || 'Not Specified']
    );
    
    const participantId = participant.rows[0].participant_id;
    const registrationIds = [];
    
    // 7. PROCESS EVENTS & WORKSHOPS - Single pass
    const processEvent = async (eventId, type) => {
      const event = await client.query(
        `SELECT event_id, event_name, day, cse_available_seats, event_type 
         FROM events WHERE event_id=$1 AND is_active=true`, [eventId]
      );
      
      if (!event.rows[0]) throw new Error(`EVENT_NOT_FOUND: ${eventId}`);
      if (event.rows[0].cse_available_seats <= 0) throw new Error(`SEATS_FULL: ${event.rows[0].event_name}`);
      
      const regId = `THREADS26-SONA-${Date.now()}-${eventId}`;
      const amount = type === 'workshop' ? 300 : 0;
      const status = type === 'workshop' ? 'Pending' : 'Success';
      
      await client.query(
        `INSERT INTO registrations (participant_id, event_id, registration_unique_id, payment_status, amount_paid, event_name, day)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [participantId, eventId, regId, status, amount, event.rows[0].event_name, event.rows[0].day]
      );
      
      await client.query(
        `UPDATE events SET cse_available_seats = cse_available_seats - 1, available_seats = available_seats - 1
         WHERE event_id = $1`, [eventId]
      );
      
      registrationIds.push(regId);
      return { event_id: eventId, event_name: event.rows[0].event_name, registration_id: regId };
    };
    
    // Process all selections
    const processedEvents = await Promise.all(event_selections.map(id => processEvent(parseInt(id), 'event')));
    const processedWorkshops = await Promise.all(workshop_selections.map(id => processEvent(parseInt(id), 'workshop')));
    
    await client.query('COMMIT');
    
    // 8. GENERATE SIMPLE QR PAYLOAD
    let qrCodeBase64 = null;
    if (!needsPayment) {
      const qrPayload = {
        pid: participantId,
        ids: registrationIds.join('|')  // Simple pipe-separated
      };
      
      qrCodeBase64 = await QRCode.toDataURL(JSON.stringify(qrPayload), {
        errorCorrectionLevel: 'L', margin: 0, width: 200
      }).catch(() => null);
    }
    
    // 9. FAST RESPONSE
    return reply.code(201).send({
      success: true,
      participant_id: participantId,
      name: studentName,
      year: year,
      events: processedEvents.length,
      workshops: processedWorkshops.length,
      amount: totalAmount,
      needs_payment: needsPayment,
      qr: qrCodeBase64,
      reg_ids: registrationIds,
      payment_ref: needsPayment ? `SONA-${participantId}-${Date.now()}` : null
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    return reply.code(400).send({ 
      success: false, 
      error: error.message.split(':')[0],
      details: error.message.split(':')[1]?.trim() || error.message
    });
  } finally {
    client.release();
  }
});

fastify.post('/api/sonacse/verify-payment', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    // 1. FAST VALIDATION
    const { participant_id, transaction_id, amount } = request.body;
    
    if (!participant_id) throw new Error('PARTICIPANT_ID_REQUIRED');
    if (!transaction_id) throw new Error('TRANSACTION_ID_REQUIRED');
    
    const participantId = parseInt(participant_id);
    
    // 2. CHECK PARTICIPANT - Single query
    const participant = await client.query(
      'SELECT participant_id, full_name, year_of_study FROM participants WHERE participant_id = $1',
      [participantId]
    );
    if (participant.rows.length === 0) throw new Error('PARTICIPANT_NOT_FOUND');
    
    // 3. CHECK DUPLICATE TRANSACTION
    const duplicate = await client.query('SELECT 1 FROM payments WHERE transaction_id = $1', [transaction_id]);
    if (duplicate.rows.length > 0) throw new Error('DUPLICATE_TRANSACTION');
    
    // 4. GET PENDING WORKSHOPS - Single query
    const workshops = await client.query(
      `SELECT r.event_id, r.registration_unique_id, r.event_name, e.cse_available_seats
       FROM registrations r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1 AND r.payment_status = 'Pending' AND r.amount_paid > 0`,
      [participantId]
    );
    
    if (workshops.rows.length === 0) throw new Error('NO_PENDING_WORKSHOPS');
    
    // 5. CALCULATE AMOUNT
    const year = parseInt(participant.rows[0].year_of_study);
    const workshopCount = workshops.rows.length;
    const workshopsAmount = workshopCount * 300;
    
    // Get events (if any)
    const events = await client.query(
      `SELECT COUNT(*) FROM registrations 
       WHERE participant_id = $1 AND amount_paid = 0`, [participantId]
    );
    const eventCount = parseInt(events.rows[0].count);
    
    const eventsAmount = year === 1 ? Math.max(0, (eventCount * 25) - 50) : 0;
    const totalAmount = eventsAmount + workshopsAmount;
    
    // 6. VERIFY AMOUNT
    if (Math.abs(parseFloat(amount) - totalAmount) > 0.01) {
      throw new Error(`AMOUNT_MISMATCH: Expected ₹${totalAmount}`);
    }
    
    // 7. START TRANSACTION
    await client.query('BEGIN');
    
    // 8. RESERVE SEATS
    for (const w of workshops.rows) {
      if (w.cse_available_seats <= 0) throw new Error(`SEATS_FULL: ${w.event_name}`);
      
      await client.query(
        `UPDATE events SET cse_available_seats = cse_available_seats - 1, available_seats = available_seats - 1
         WHERE event_id = $1`, [w.event_id]
      );
    }
    
    // 9. SAVE PAYMENT
    await client.query(
      `INSERT INTO payments (participant_id, transaction_id, amount, payment_status, verified_by_admin)
       VALUES ($1, $2, $3, 'Success', false)`,
      [participantId, transaction_id, totalAmount]
    );
    
    // 10. MARK WORKSHOPS CONFIRMED
    await client.query(
      `UPDATE registrations SET payment_status = 'Success'
       WHERE participant_id = $1 AND payment_status = 'Pending'`,
      [participantId]
    );
    
    await client.query('COMMIT');
    
    // 11. GET ALL REGISTRATION IDs
    const allRegs = await client.query(
      `SELECT registration_unique_id FROM registrations 
       WHERE participant_id = $1 ORDER BY registered_at`,
      [participantId]
    );
    
    const registrationIds = allRegs.rows.map(r => r.registration_unique_id);
    
    // 12. GENERATE SIMPLE QR
    const qrPayload = {
      pid: participantId,
      ids: registrationIds.join('|')
    };
    
    const qrCode = await QRCode.toDataURL(JSON.stringify(qrPayload), {
      errorCorrectionLevel: 'L', margin: 0, width: 200
    }).catch(() => null);
    
    // 13. FAST RESPONSE
    return reply.send({
      success: true,
      participant_id: participantId,
      name: participant.rows[0].full_name,
      amount_paid: totalAmount,
      workshops_confirmed: workshopCount,
      events_count: eventCount,
      qr_code: qrCode,
      registration_ids: registrationIds
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    return reply.code(400).send({
      success: false,
      error: error.message.split(':')[0],
      details: error.message.split(':')[1]?.trim() || error.message
    });
  } finally {
    client.release();
  }
});


// FAST SIMPLE ENDPOINT for quick loading
fastify.get('/api/super-admin/quick', async (request, reply) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM participants) as total_participants,
        (SELECT COUNT(*) FROM registrations) as total_registrations,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE payment_status = 'Success') as total_revenue,
        (SELECT COUNT(*) FROM events WHERE is_active = true) as active_events,
        (SELECT COUNT(*) FROM registrations WHERE DATE(registered_at) = CURRENT_DATE) as today_registrations,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE DATE(created_at) = CURRENT_DATE AND payment_status = 'Success') as today_revenue,
        (SELECT COUNT(*) FROM payments WHERE verified_by_admin = false AND payment_status = 'Success') as pending_verifications
    `);

    const lowSeats = await pool.query(`
      SELECT event_name, available_seats 
      FROM events 
      WHERE is_active = true AND available_seats < 10
      ORDER BY available_seats ASC 
      LIMIT 5
    `);

    return {
      success: true,
      timestamp: new Date().toISOString(),
      overview: stats.rows[0],
      low_seat_events: lowSeats.rows,
      registration_open: moment().isBefore(moment(EVENT_DATES.registration_closes))
    };

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ 
      error: 'Failed to load quick stats',
      details: error.message 
    });
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
