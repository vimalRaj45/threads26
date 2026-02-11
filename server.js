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

  // 🔑 Concurrency & Load tuning
  max: 5,                   // max DB connections
  min: 2,                    // keep some warm connections
  idleTimeoutMillis: 30000,  // close idle clients after 30s
  connectionTimeoutMillis: 2000, // wait max 2s for connection
  keepAlive: true,
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




// Event dates (for auto-close feature)
const EVENT_DATES = {
  workshop_day: moment().add(5, 'days').format('YYYY-MM-DD'), // Day 1 (5 days from today)
  event_day: moment().add(6, 'days').format('YYYY-MM-DD'),    // Day 2 (6 days from today)
  registration_closes: moment().add(4, 'days').format('YYYY-MM-DD') // Day before event (4 days from today)
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
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. VALIDATE ALL REQUIRED FIELDS WITH SPECIFIC ERRORS
    const validationErrors = [];
    
    if (!request.body.full_name || request.body.full_name.trim() === '') {
      validationErrors.push('FULL_NAME_REQUIRED: Full name is required');
    }
    
    if (!request.body.email || request.body.email.trim() === '') {
      validationErrors.push('EMAIL_REQUIRED: Email address is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.body.email)) {
      validationErrors.push('EMAIL_INVALID: Email format is invalid (example@domain.com)');
    }
    
    if (!request.body.phone || request.body.phone.trim() === '') {
      validationErrors.push('PHONE_REQUIRED: Phone number is required');
    } else if (request.body.phone.replace(/\D/g, '').length < 10) {
      validationErrors.push('PHONE_INVALID: Phone must be at least 10 digits');
    }
    
    if (!request.body.college_name || request.body.college_name.trim() === '') {
      validationErrors.push('COLLEGE_REQUIRED: College name is required');
    }
    
    if (!request.body.department || request.body.department.trim() === '') {
      validationErrors.push('DEPARTMENT_REQUIRED: Department is required (CSE, IT, ECE, etc.)');
    } else if (!['CSE', 'IT', 'ECE', 'EEE', 'MECH', 'OTH'].includes(request.body.department.toUpperCase())) {
      validationErrors.push('DEPARTMENT_INVALID: Department must be CSE, IT, ECE, EEE, MECH, or OTH');
    }
    
    if (!request.body.year_of_study) {
      validationErrors.push('YEAR_REQUIRED: Year of study is required (1, 2, 3, or 4)');
    } else if (![1, 2, 3, 4].includes(parseInt(request.body.year_of_study))) {
      validationErrors.push('YEAR_INVALID: Year of study must be 1, 2, 3, or 4');
    }
    
    if (validationErrors.length > 0) {
      throw new Error(`VALIDATION_FAILED: ${validationErrors.join(' | ')}`);
    }
    
    const {
      full_name,
      email,
      phone,
      college_name,
      department,
      year_of_study,
      city = '',
      state = '',
      accommodation_required = false,
      workshop_selections = [],
      event_selections = []
    } = request.body;
    
    // 2. CHECK REGISTRATION DEADLINE
    const today = moment();
    if (today.isAfter(moment(EVENT_DATES.registration_closes))) {
      throw new Error('REGISTRATION_CLOSED: Registration is closed. Please contact organizers.');
    }
    
    // 3. CHECK FOR DUPLICATE EMAIL
    const existing = await client.query(
      'SELECT * FROM participants WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    
    if (existing.rows.length > 0) {
      throw new Error('EMAIL_EXISTS: This email is already registered. Please use a different email.');
    }
    
    // 4. INSERT PARTICIPANT
    const participantResult = await client.query(
      `INSERT INTO participants (
        full_name, email, phone, college_name, department,
        year_of_study, city, state, accommodation_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING participant_id`,
      [
        full_name.trim(),
        email.toLowerCase().trim(),
        phone.replace(/\D/g, ''),
        college_name.trim(),
        department.toUpperCase().trim(),
        parseInt(year_of_study),
        city.trim(),
        state.trim(),
        Boolean(accommodation_required)
      ]
    );
    
    const participantId = participantResult.rows[0].participant_id;
    const registrationIds = [];
    let totalAmount = 0;
    
    // 5. VALIDATE EVENT SELECTIONS
    if (workshop_selections.length === 0 && event_selections.length === 0) {
      throw new Error('NO_EVENTS_SELECTED: Please select at least one workshop or event');
    }
    
    // 6. DEFINE SEAT CHECK FUNCTION - DIRECT DATABASE QUERY (NO REDIS)
    const checkSeatAvailability = async (eventId, dept) => {
      // Direct database query - no cache
      const event = await client.query(
        `SELECT 
          event_id,
          event_name,
          total_seats,
          available_seats,
          cse_seats,
          cse_available_seats,
          is_active,
          event_type,
          day
         FROM events 
         WHERE event_id = $1`,
        [eventId]
      );
      
      if (!event.rows[0]) {
        throw new Error(`EVENT_NOT_FOUND: Event ID ${eventId} not found`);
      }
      
      const eventData = event.rows[0];
      
      if (!eventData.is_active) {
        throw new Error(`EVENT_INACTIVE: Event "${eventData.event_name}" is no longer available`);
      }
      
      if (dept === 'CSE') {
        if (eventData.cse_available_seats <= 0) {
          throw new Error(`CSE_SEATS_FULL: No CSE seats available for "${eventData.event_name}". CSE seats: ${eventData.cse_available_seats}/${eventData.cse_seats}`);
        }
      } else {
        if (eventData.available_seats <= 0) {
          throw new Error(`GENERAL_SEATS_FULL: No general seats available for "${eventData.event_name}". General seats: ${eventData.available_seats}/${eventData.total_seats}`);
        }
      }
      
      return true;
    };
    
    // 7. PROCESS WORKSHOPS (CHECK SEATS BUT DON'T DECREMENT)
    const processedWorkshops = [];
    for (const eventId of workshop_selections) {
      const eventIdNum = parseInt(eventId);
      if (isNaN(eventIdNum) || eventIdNum <= 0) {
        throw new Error(`INVALID_WORKSHOP_ID: Workshop ID "${eventId}" is invalid`);
      }
      
      // Check if workshop exists and is type 'workshop'
      const event = await client.query(
        'SELECT event_name, fee, day, event_type FROM events WHERE event_id = $1',
        [eventId]
      );
      
      if (event.rows.length === 0) {
        throw new Error(`WORKSHOP_NOT_FOUND: Workshop ID ${eventId} not found`);
      }
      
      if (event.rows[0].event_type !== 'workshop') {
        throw new Error(`NOT_A_WORKSHOP: Event ID ${eventId} is not a workshop (type: ${event.rows[0].event_type})`);
      }
      
      // CHECK seat availability (direct DB query)
      await checkSeatAvailability(eventId, department);
      
      // Generate registration ID
      const prefix = 'THREADS26-WS-';
      const deptCode = department === 'CSE' ? 'CSE' : 'OTH';
      const timestamp = Date.now().toString().slice(-9);
      const baseRegId = `${prefix}${deptCode}-${timestamp}`;
      const regId = `${baseRegId}-${eventId}`;
      
      // Insert registration as PENDING
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          participantId,
          eventId,
          regId,
          'Pending', // Payment status is Pending
          parseFloat(event.rows[0].fee) || 0,
          event.rows[0].event_name,
          event.rows[0].day
        ]
      );
      
      // ❌ NO SEAT DECREMENT HERE - Will happen after payment
      
      registrationIds.push(regId);
      totalAmount += parseFloat(event.rows[0].fee) || 0;
      processedWorkshops.push(eventId);
    }
    
    // 8. PROCESS EVENTS (CHECK SEATS BUT DON'T DECREMENT)
    const processedEvents = [];
    for (const eventId of event_selections) {
      const eventIdNum = parseInt(eventId);
      if (isNaN(eventIdNum) || eventIdNum <= 0) {
        throw new Error(`INVALID_EVENT_ID: Event ID "${eventId}" is invalid`);
      }
      
      // Check if event exists and is day 2
      const event = await client.query(
        'SELECT event_name, fee, day FROM events WHERE event_id = $1',
        [eventId]
      );
      
      if (event.rows.length === 0) {
        throw new Error(`EVENT_NOT_FOUND: Event ID ${eventId} not found`);
      }
      
      if (event.rows[0].day !== 2) {
        throw new Error(`NOT_DAY2_EVENT: Event ID ${eventId} is not a Day 2 event (day: ${event.rows[0].day})`);
      }
      
      // CHECK seat availability (direct DB query)
      await checkSeatAvailability(eventId, department);
      
      // Generate registration ID
      const prefix = 'THREADS26-EV-';
      const deptCode = department === 'CSE' ? 'CSE' : 'OTH';
      const timestamp = Date.now().toString().slice(-9);
      const baseRegId = `${prefix}${deptCode}-${timestamp}`;
      const regId = `${baseRegId}-${eventId}`;
      
      // Insert registration as PENDING
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          participantId,
          eventId,
          regId,
          'Pending', // Payment status is Pending
          parseFloat(event.rows[0].fee) || 0,
          event.rows[0].event_name,
          event.rows[0].day
        ]
      );
      
      // ❌ NO SEAT DECREMENT HERE - Will happen after payment
      
      registrationIds.push(regId);
      totalAmount += parseFloat(event.rows[0].fee) || 0;
      processedEvents.push(eventId);
    }
    
    // 9. CREATE PAYMENT REFERENCE
    const paymentReference = `THREADS26-${participantId}-${Date.now().toString().slice(-6)}`;
    
    // 10. COMMIT TRANSACTION
    await client.query('COMMIT');
    
    // 11. RETURN SUCCESS RESPONSE
    return reply.code(201).send({
      success: true,
      message: 'Registration successful! Seats will be reserved after payment verification.',
      participant_id: participantId,
      participant_name: full_name,
      department: department,
      registration_ids: registrationIds,
      workshops_registered: processedWorkshops.length,
      events_registered: processedEvents.length,
      total_amount: totalAmount,
      payment_reference: paymentReference,
      seat_status: {
        message: department === 'CSE' 
          ? 'CSE seats checked - will reserve after payment' 
          : 'General seats checked - will reserve after payment',
        department: department,
        note: 'Seats are NOT reserved yet. Complete payment to reserve your seats.'
      },
      next_steps: 'Complete payment using the payment reference above to reserve your seats',
      payment_options: {
        upi_id: process.env.UPI_ID || 'threads26@okaxis',
        payment_reference: paymentReference,
        amount: totalAmount
      }
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    
    // 12. ANALYZE ERROR AND RETURN SPECIFIC MESSAGE
    const errorMessage = error.message;
    
    // Categorize errors
    if (errorMessage.includes('CSE_SEATS_FULL')) {
      return reply.code(400).send({
        success: false,
        error_type: 'SEAT_UNAVAILABLE',
        error_code: 'CSE_SEATS_EXHAUSTED',
        message: 'CSE seats are full for selected workshop/event',
        details: errorMessage.replace('CSE_SEATS_FULL: ', ''),
        suggestion: 'Please select different events or contact organizers',
        department: 'CSE'
      });
    }
    
    if (errorMessage.includes('GENERAL_SEATS_FULL')) {
      return reply.code(400).send({
        success: false,
        error_type: 'SEAT_UNAVAILABLE',
        error_code: 'GENERAL_SEATS_EXHAUSTED',
        message: 'General seats are full for selected workshop/event',
        details: errorMessage.replace('GENERAL_SEATS_FULL: ', ''),
        suggestion: 'Please select different events'
      });
    }
    
    if (errorMessage.includes('EVENT_NOT_FOUND')) {
      return reply.code(400).send({
        success: false,
        error_type: 'EVENT_ERROR',
        error_code: 'EVENT_NOT_FOUND',
        message: 'Selected event not found',
        details: errorMessage.replace('EVENT_NOT_FOUND: ', ''),
        suggestion: 'Please refresh the event list and try again'
      });
    }
    
    if (errorMessage.includes('EVENT_INACTIVE')) {
      return reply.code(400).send({
        success: false,
        error_type: 'EVENT_ERROR',
        error_code: 'EVENT_INACTIVE',
        message: 'Selected event is no longer available',
        details: errorMessage.replace('EVENT_INACTIVE: ', ''),
        suggestion: 'Please select a different event'
      });
    }
    
    // ... (keep other error handling same)
    return reply.code(400).send({
      success: false,
      error_type: 'REGISTRATION_ERROR',
      error_code: 'UNKNOWN_ERROR',
      message: 'Registration failed',
      details: errorMessage,
      suggestion: 'Please try again or contact support'
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

fastify.post('/api/verify-payment', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    // 1. VALIDATE INPUT DATA WITH SPECIFIC ERRORS
    const validationErrors = [];
    
    if (!request.body.participant_id) {
      validationErrors.push('PARTICIPANT_ID_REQUIRED: Participant ID is required');
    } else if (isNaN(parseInt(request.body.participant_id)) || parseInt(request.body.participant_id) <= 0) {
      validationErrors.push('PARTICIPANT_ID_INVALID: Participant ID must be a positive number');
    }
    
    if (!request.body.transaction_id || request.body.transaction_id.trim() === '') {
      validationErrors.push('TRANSACTION_ID_REQUIRED: Transaction ID is required');
    } else if (request.body.transaction_id.length < 5) {
      validationErrors.push('TRANSACTION_ID_INVALID: Transaction ID must be at least 5 characters');
    }
    
    if (validationErrors.length > 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'INPUT_VALIDATION',
        error_code: 'REQUIRED_FIELDS_MISSING',
        message: 'Please check the following fields:',
        validation_errors: validationErrors.map(err => {
          const [code, message] = err.split(': ');
          return { field_code: code, message };
        })
      });
    }
    
    const {
      participant_id,
      transaction_id,
      payment_reference,
      payment_method = 'UPI'
    } = request.body;
    
    const participantId = parseInt(participant_id);
    const cleanTransactionId = transaction_id.trim();
    
    // 2. PREVENT DUPLICATE TRANSACTION
    const duplicateCheck = await client.query(
      'SELECT 1 FROM payments WHERE transaction_id = $1',
      [cleanTransactionId]
    );
    
    if (duplicateCheck.rows.length > 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'DUPLICATE_TRANSACTION',
        error_code: 'TRANSACTION_ALREADY_USED',
        message: 'Transaction ID already used',
        details: 'Please use a different transaction ID',
        transaction_id: cleanTransactionId
      });
    }
    
    // 3. CHECK PARTICIPANT EXISTS AND GET DEPARTMENT
    const participantCheck = await client.query(
      'SELECT participant_id, full_name, department FROM participants WHERE participant_id = $1',
      [participantId]
    );
    
    if (participantCheck.rows.length === 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'PARTICIPANT_NOT_FOUND',
        error_code: 'INVALID_PARTICIPANT_ID',
        message: 'Participant not found',
        details: `No participant found with ID ${participantId}`,
        suggestion: 'Check the participant ID and try again'
      });
    }
    
    const department = participantCheck.rows[0].department;
    
    // 4. CHECK FOR PENDING REGISTRATIONS
    const pendingRegistrations = await client.query(
      `SELECT 
        r.registration_id,
        r.event_id,
        r.registration_unique_id,
        r.amount_paid,
        r.event_name,
        e.day,
        e.event_type
       FROM registrations r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1 AND r.payment_status = 'Pending'`,
      [participantId]
    );
    
    if (pendingRegistrations.rows.length === 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'NO_PENDING_REGISTRATIONS',
        error_code: 'NO_PAYMENT_REQUIRED',
        message: 'No pending registrations found',
        details: 'This participant has no pending registrations to pay for',
        participant_id: participantId,
        participant_name: participantCheck.rows[0].full_name,
        suggestion: 'Check if payment was already completed'
      });
    }
    
    // 5. CALCULATE TOTAL AMOUNT
    const totalAmount = pendingRegistrations.rows.reduce(
      (sum, reg) => sum + parseFloat(reg.amount_paid || 0),
      0
    );
    
    if (totalAmount <= 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'INVALID_AMOUNT',
        error_code: 'ZERO_AMOUNT',
        message: 'Invalid payment amount',
        details: 'Total amount calculated is zero or negative',
        suggestion: 'Contact support for assistance'
      });
    }
    
    // 6. START TRANSACTION
    await client.query('BEGIN');
    
    // 7. SAVE PAYMENT RECORD
    const paymentResult = await client.query(
      `INSERT INTO payments (
        participant_id, 
        transaction_id, 
        payment_reference,
        amount, 
        payment_method, 
        payment_status,
        verified_by_admin,
        verified_at,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, 'Success', false, NOW(), NOW())
      RETURNING payment_id, created_at`,
      [
        participantId,
        cleanTransactionId,
        payment_reference?.trim() || `PAY-${Date.now().toString().slice(-8)}`,
        totalAmount,
        payment_method
      ]
    );
    
    // 8. DEFINE SEAT UPDATE FUNCTION (NOW DECREMENTING SEATS)
    const updateSeats = async (eventId, department, increment = false) => {
      const op = increment ? '+' : '-';
      
      if (department === 'CSE') {
        await client.query(
          `UPDATE events SET cse_available_seats = cse_available_seats ${op} 1 WHERE event_id = $1`,
          [eventId]
        );
      }
      
      await client.query(
        `UPDATE events SET available_seats = available_seats ${op} 1 WHERE event_id = $1`,
        [eventId]
      );
      
      await redis.del(`seats:${eventId}`);
    };
    
    // 9. CHECK AND DECREMENT SEATS FOR EACH REGISTRATION
    const seatLocks = [];
    for (const reg of pendingRegistrations.rows) {
      // Acquire lock for this event to prevent race conditions
      const lockKey = `seat_lock:${reg.event_id}:${Date.now()}`;
      const lockAcquired = await redis.set(lockKey, 'locked', { nx: true, ex: 3 });
      if (!lockAcquired) {
        throw new Error(`Event ${reg.event_id} is being processed. Please try again.`);
      }
      seatLocks.push(lockKey);
      
      // Check if event still has seats available
      const event = await client.query(
        'SELECT event_name, cse_available_seats, available_seats FROM events WHERE event_id = $1 AND is_active = true',
        [reg.event_id]
      );
      
      if (event.rows.length === 0) {
        throw new Error(`Event ${reg.event_id} not found or inactive`);
      }
      
      const eventData = event.rows[0];
      
      // Check seat availability again (in case seats filled since registration)
      if (department === 'CSE') {
        if (eventData.cse_available_seats <= 0) {
          throw new Error(`CSE_SEATS_FULL_AT_PAYMENT: No CSE seats available for "${reg.event_name}". Seats filled before payment.`);
        }
      } else {
        if (eventData.available_seats <= 0) {
          throw new Error(`GENERAL_SEATS_FULL_AT_PAYMENT: No general seats available for "${reg.event_name}". Seats filled before payment.`);
        }
      }
      
      // ✅ DECREMENT SEATS HERE (AFTER PAYMENT VERIFICATION)
      await updateSeats(reg.event_id, department, false);
    }
    
    // 10. MARK REGISTRATIONS AS CONFIRMED
    const updateResult = await client.query(
      `UPDATE registrations
       SET payment_status = 'Success'
       WHERE participant_id = $1 AND payment_status = 'Pending'
       RETURNING registration_unique_id`,
      [participantId]
    );
    
    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return reply.code(400).send({
        success: false,
        error_type: 'UPDATE_FAILED',
        error_code: 'REGISTRATION_UPDATE_ERROR',
        message: 'Failed to update registrations',
        details: 'Could not mark registrations as paid',
        suggestion: 'Contact support for assistance'
      });
    }
    
    // 11. COMMIT TRANSACTION
    await client.query('COMMIT');
    
    // 12. RELEASE SEAT LOCKS
    for (const lockKey of seatLocks) {
      await redis.del(lockKey).catch(() => {});
    }
    
    // 13. GET ALL SUCCESSFUL REGISTRATION IDS
    const allRegistrations = await client.query(
      `SELECT registration_unique_id 
       FROM registrations 
       WHERE participant_id = $1 AND payment_status = 'Success'
       ORDER BY registered_at`,
      [participantId]
    );
    
    const registrationIds = allRegistrations.rows.map(r => r.registration_unique_id);
    
    // 14. GENERATE QR CODE
    const qrPayload = {
      participant_id: participantId,
      registration_ids: registrationIds,
      event: "THREADS'26"
    };
    
    let qrCodeBase64;
    try {
      qrCodeBase64 = await QRCode.toDataURL(
        JSON.stringify(qrPayload),
        {
          errorCorrectionLevel: 'H',
          type: 'image/png',
          margin: 1,
          width: 250,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        }
      );
    } catch (qrError) {
      console.error('QR generation error:', qrError);
      qrCodeBase64 = null;
    }
    
    // 15. GET PARTICIPANT DETAILS
    const participantDetails = participantCheck.rows[0];
    
    // 16. CLEANUP CACHES
    try {
      await redis.del(`verification:${participantId}`);
      await redis.del('admin_stats');
      for (const reg of pendingRegistrations.rows) {
        await redis.del(`track:${reg.registration_unique_id}`);
      }
    } catch (cacheError) {
      console.error('Cache cleanup error:', cacheError);
    }
    
    // 17. RETURN SUCCESS RESPONSE
    const response = {
      success: true,
      message: '🎉 Payment verified successfully! Seats have been reserved.',
      payment_details: {
        participant_id: participantId,
        participant_name: participantDetails.full_name,
        department: department,
        transaction_id: cleanTransactionId,
        amount: totalAmount,
        payment_id: paymentResult.rows[0].payment_id,
        payment_date: paymentResult.rows[0].created_at,
        payment_status: 'Verified'
      },
      seat_status: {
        message: department === 'CSE' 
          ? '✅ CSE seats successfully reserved after payment' 
          : '✅ General seats successfully reserved after payment',
        department: department,
        seats_reserved: pendingRegistrations.rows.length
      },
      registration_details: {
        total_registrations: registrationIds.length,
        registration_ids: registrationIds,
        events_registered: pendingRegistrations.rows.map(r => ({
          event_name: r.event_name,
          registration_id: r.registration_unique_id,
          amount: r.amount_paid,
          seat_type: department === 'CSE' ? 'CSE Quota' : 'General Quota'
        }))
      }
    };
    
    // Add QR code if generated successfully
    if (qrCodeBase64) {
      response.qr_code = qrCodeBase64;
      response.qr_payload = qrPayload;
    }
    
    return reply.send(response);
    
  } catch (error) {
    // 18. ROLLBACK ON ERROR
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback error:', rollbackError);
    }
    
    // 19. ANALYZE ERROR
    const errorMessage = error.message;
    
    // Handle seat-related errors during payment
    if (errorMessage.includes('CSE_SEATS_FULL_AT_PAYMENT')) {
      return reply.code(400).send({
        success: false,
        error_type: 'SEAT_UNAVAILABLE_AT_PAYMENT',
        error_code: 'CSE_SEATS_FILLED_BEFORE_PAYMENT',
        message: 'CSE seats filled before payment completion',
        details: errorMessage.replace('CSE_SEATS_FULL_AT_PAYMENT: ', ''),
        suggestion: 'Contact organizers for assistance. Your payment was not processed.',
        department: 'CSE'
      });
    }
    
    if (errorMessage.includes('GENERAL_SEATS_FULL_AT_PAYMENT')) {
      return reply.code(400).send({
        success: false,
        error_type: 'SEAT_UNAVAILABLE_AT_PAYMENT',
        error_code: 'GENERAL_SEATS_FILLED_BEFORE_PAYMENT',
        message: 'General seats filled before payment completion',
        details: errorMessage.replace('GENERAL_SEATS_FULL_AT_PAYMENT: ', ''),
        suggestion: 'Contact organizers for assistance. Your payment was not processed.'
      });
    }
    
    // 20. RETURN GENERIC ERROR
    fastify.log.error('Payment verification error:', error);
    
    return reply.code(400).send({
      success: false,
      error_type: 'PAYMENT_VERIFICATION_ERROR',
      error_code: 'PROCESSING_ERROR',
      message: 'Payment verification failed',
      details: errorMessage,
      suggestion: 'Please try again or contact support'
    });
    
  } finally {
    // 21. RELEASE CLIENT
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
    const { registration_id } = request.body;

    if (!registration_id) {
      return reply.code(400).send({ 
        success: false,
        error: 'registration_id is required' 
      });
    }

    // 1️⃣ Get registration details
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
       WHERE r.registration_unique_id = $1`,
      [registration_id]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ 
        success: false,
        error: 'Registration not found' 
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
        event_type: eventType
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
          [registration_id]
        );

        return reply.send({
          success: true,
          message: '✅ SONACSE Event attendance marked successfully',
          participant_type: 'SONACSE',
          event_type: 'EVENT',
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
          [registration_id]
        );

        return reply.send({
          success: true,
          message: '✅ SONACSE Workshop attendance marked successfully',
          participant_type: 'SONACSE',
          event_type: 'WORKSHOP',
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
          [registration_id]
        );

        return reply.send({
          success: true,
          message: '✅ Event attendance marked successfully',
          participant_type: 'REGULAR',
          event_type: 'EVENT',
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
          [registration_id]
        );

        return reply.send({
          success: true,
          message: '✅ Workshop attendance marked successfully',
          participant_type: 'REGULAR',
          event_type: 'WORKSHOP',
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
      [registration_id]
    );

    return reply.send({
      success: true,
      message: '✅ Attendance marked successfully',
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
      'SELECT participant_id, full_name, email, phone, college_name, department, year_of_study, city, state FROM participants WHERE participant_id = $1',
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






//cse endpoints 

// Add this at the top with other constants
const SONACSE_STUDENTS = [
  '21CSE001', '21CSE002', '21CSE003', '21CSE004', '21CSE005',
  '21CSE006', '21CSE007', '21CSE008', '21CSE009', '21CSE010',
  '22CSE001', '22CSE002', '22CSE003', '22CSE004', '22CSE005',
  '23CSE001', '23CSE002', '23CSE003', '23CSE004', '23CSE005',
  '24CSE001', '24CSE002', '24CSE003', '24CSE004', '24CSE005'
];

fastify.post('/api/sonacse/register', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. VALIDATE ALL REQUIRED FIELDS WITH SONACSE-SPECIFIC VALIDATION
    const validationErrors = [];
    
    if (!request.body.roll_number || request.body.roll_number.trim() === '') {
      validationErrors.push('ROLL_NUMBER_REQUIRED: Roll number is required for SONACSE registration');
    } else {
      const rollNumber = request.body.roll_number.trim().toUpperCase();
      if (!SONACSE_STUDENTS.includes(rollNumber)) {
        validationErrors.push('INVALID_SONACSE_ROLL: Roll number not found in SONACSE student list');
      }
    }
    
    if (!request.body.full_name || request.body.full_name.trim() === '') {
      validationErrors.push('FULL_NAME_REQUIRED: Full name is required');
    }
    
    if (!request.body.email || request.body.email.trim() === '') {
      validationErrors.push('EMAIL_REQUIRED: Email address is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.body.email)) {
      validationErrors.push('EMAIL_INVALID: Email format is invalid (example@domain.com)');
    }
    
    if (!request.body.phone || request.body.phone.trim() === '') {
      validationErrors.push('PHONE_REQUIRED: Phone number is required');
    } else if (request.body.phone.replace(/\D/g, '').length < 10) {
      validationErrors.push('PHONE_INVALID: Phone must be at least 10 digits');
    }
    
    if (!request.body.year_of_study) {
      validationErrors.push('YEAR_REQUIRED: Year of study is required (1, 2, 3, or 4)');
    } else if (![1, 2, 3, 4].includes(parseInt(request.body.year_of_study))) {
      validationErrors.push('YEAR_INVALID: Year of study must be 1, 2, 3, or 4');
    }
    
    if (validationErrors.length > 0) {
      throw new Error(`VALIDATION_FAILED: ${validationErrors.join(' | ')}`);
    }
    
    const {
      roll_number,
      full_name,
      email,
      phone,
      year_of_study,
      workshop_selections = [],
      event_selections = []
    } = request.body;
    
    const cleanRollNumber = roll_number.trim().toUpperCase();
    const department = 'CSE'; // Force CSE for SONACSE students
    const college_name = 'Sona College of Technology (SONACSE)';
    
    // 2. CHECK REGISTRATION DEADLINE
    const today = moment();
    if (today.isAfter(moment(EVENT_DATES.registration_closes))) {
      throw new Error('REGISTRATION_CLOSED: Registration is closed. Please contact organizers.');
    }
    
    // 3. CHECK FOR DUPLICATE EMAIL (using email instead of roll number)
    const existingEmail = await client.query(
      'SELECT * FROM participants WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    
    if (existingEmail.rows.length > 0) {
      throw new Error('EMAIL_EXISTS: This email is already registered. Please use a different email.');
    }
    
    // 4. VALIDATE EVENT SELECTIONS
    if (workshop_selections.length === 0 && event_selections.length === 0) {
      throw new Error('NO_EVENTS_SELECTED: Please select at least one workshop or event');
    }
    
    // 5. CHECK IF ANY WORKSHOPS ARE SELECTED
    const hasWorkshops = workshop_selections.length > 0;
    const hasEventsOnly = workshop_selections.length === 0 && event_selections.length > 0;
    
    // 6. INSERT PARTICIPANT (NO ROLL_NUMBER COLUMN - using regular insertion)
    const participantResult = await client.query(
      `INSERT INTO participants (
        full_name, email, phone, college_name, department,
        year_of_study, city, state, accommodation_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING participant_id`,
      [
        full_name.trim(),
        email.toLowerCase().trim(),
        phone.replace(/\D/g, ''),
        college_name,
        department,
        parseInt(year_of_study),
        'Chennai', // Default for SONACSE
        'Tamil Nadu', // Default for SONACSE
        false // Default no accommodation for SONACSE
      ]
    );
    
    const participantId = participantResult.rows[0].participant_id;
    const registrationIds = [];
    let totalAmount = 0;
    let needsPayment = false;
    
    // 7. DEFINE SEAT CHECK FUNCTION FOR SONACSE (CSE seats only)
    const checkSeatAvailability = async (eventId) => {
      const event = await client.query(
        `SELECT 
          event_id,
          event_name,
          cse_available_seats,
          is_active,
          event_type,
          day
         FROM events 
         WHERE event_id = $1`,
        [eventId]
      );
      
      if (!event.rows[0]) {
        throw new Error(`EVENT_NOT_FOUND: Event ID ${eventId} not found`);
      }
      
      const eventData = event.rows[0];
      
      if (!eventData.is_active) {
        throw new Error(`EVENT_INACTIVE: Event "${eventData.event_name}" is no longer available`);
      }
      
      if (eventData.cse_available_seats <= 0) {
        throw new Error(`SONACSE_SEATS_FULL: No SONACSE seats available for "${eventData.event_name}". Available: ${eventData.cse_available_seats}`);
      }
      
      return eventData;
    };
    
    // 8. DEFINE SEAT DECREMENT FUNCTION
    const decrementSeats = async (eventId) => {
      await client.query(
        `UPDATE events SET 
          cse_available_seats = cse_available_seats - 1,
          available_seats = available_seats - 1
         WHERE event_id = $1`,
        [eventId]
      );
    };
    
    // 9. PROCESS EVENTS (FREE - immediate seat decrement)
    const processedEvents = [];
    for (const eventId of event_selections) {
      const eventIdNum = parseInt(eventId);
      if (isNaN(eventIdNum) || eventIdNum <= 0) {
        throw new Error(`INVALID_EVENT_ID: Event ID "${eventId}" is invalid`);
      }
      
      // Check seat availability
      const eventData = await checkSeatAvailability(eventId);
      
      // Generate registration ID with SONACSE prefix
      const prefix = 'THREADS26-SONA-';
      const timestamp = Date.now().toString().slice(-9);
      const baseRegId = `${prefix}CSE-${timestamp}`;
      const regId = `${baseRegId}-${eventId}`;
      
      // Insert registration
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          participantId,
          eventId,
          regId,
          'Success', // Events are immediately confirmed (free)
          0, // FREE for events
          eventData.event_name,
          eventData.day
        ]
      );
      
      // DECREMENT SEATS IMMEDIATELY for events
      await decrementSeats(eventId);
      
      registrationIds.push(regId);
      processedEvents.push({
        event_id: eventId,
        event_name: eventData.event_name,
        registration_id: regId
      });
    }
    
    // 10. PROCESS WORKSHOPS (PAID - seat check only, no decrement)
    const processedWorkshops = [];
    for (const eventId of workshop_selections) {
      const eventIdNum = parseInt(eventId);
      if (isNaN(eventIdNum) || eventIdNum <= 0) {
        throw new Error(`INVALID_WORKSHOP_ID: Workshop ID "${eventId}" is invalid`);
      }
      
      // Check seat availability
      const eventData = await checkSeatAvailability(eventId);
      
      // Verify it's a workshop
      if (eventData.event_type !== 'workshop') {
        throw new Error(`NOT_A_WORKSHOP: Event ID ${eventId} is not a workshop (type: ${eventData.event_type})`);
      }
      
      // Get workshop fee
      const feeResult = await client.query(
        'SELECT fee FROM events WHERE event_id = $1',
        [eventId]
      );
      
      const workshopFee = parseFloat(feeResult.rows[0].fee) || 0;
      
      // Generate registration ID with SONACSE prefix
      const prefix = 'THREADS26-SONA-';
      const timestamp = Date.now().toString().slice(-9);
      const baseRegId = `${prefix}CSE-${timestamp}`;
      const regId = `${baseRegId}-${eventId}`;
      
      // Insert registration as PENDING (needs payment)
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          participantId,
          eventId,
          regId,
          'Pending', // Needs payment
          workshopFee,
          eventData.event_name,
          eventData.day
        ]
      );
      
      // NO SEAT DECREMENT HERE - will happen after payment
      
      registrationIds.push(regId);
      totalAmount += workshopFee;
      needsPayment = true;
      processedWorkshops.push({
        event_id: eventId,
        event_name: eventData.event_name,
        registration_id: regId,
        fee: workshopFee
      });
    }
    
    // 11. COMMIT TRANSACTION
    await client.query('COMMIT');
    
    // 12. GENERATE QR CODE IF NO PAYMENT NEEDED (events only)
    let qrCodeBase64 = null;
    let qrPayload = null;
    
    if (!needsPayment && processedEvents.length > 0) {
      qrPayload = {
        participant_id: participantId,
        roll_number: cleanRollNumber, // Store roll number in QR payload only
        registration_ids: registrationIds,
        event: "THREADS'26",
        type: "SONACSE_EVENTS_ONLY",
        timestamp: new Date().toISOString()
      };
      
      try {
        qrCodeBase64 = await QRCode.toDataURL(
          JSON.stringify(qrPayload),
          {
            errorCorrectionLevel: 'H',
            type: 'image/png',
            margin: 1,
            width: 250,
            color: {
              dark: '#000000',
              light: '#ffffff'
            }
          }
        );
      } catch (qrError) {
        console.error('QR generation error:', qrError);
      }
    }
    
    // 13. CREATE PAYMENT REFERENCE IF WORKSHOPS SELECTED
    let paymentReference = null;
    if (needsPayment) {
      paymentReference = `SONACSE-WS-${participantId}-${Date.now().toString().slice(-6)}`;
    }
    
    // 14. RETURN RESPONSE BASED ON SELECTIONS
    if (hasEventsOnly && !hasWorkshops) {
      // EVENTS ONLY - FREE - IMMEDIATE CONFIRMATION
      return reply.code(201).send({
        success: true,
        message: '✅ SONACSE Registration successful! Events confirmed immediately.',
        registration_type: 'EVENTS_ONLY_FREE',
        participant_details: {
          participant_id: participantId,
          participant_name: full_name,
          roll_number: cleanRollNumber, // Return in response only
          department: department,
          college: college_name
        },
        registrations: {
          events: processedEvents,
          workshops: [],
          total_registrations: processedEvents.length
        },
        payment: {
          required: false,
          amount: 0,
          status: 'NOT_REQUIRED'
        },
        qr_code: qrCodeBase64,
        qr_payload: qrPayload,
        seat_status: {
          message: '✅ SONACSE seats reserved for all events',
          seats_reserved: processedEvents.length
        },
        next_steps: 'Show QR code at event entry. No payment required.'
      });
    } else if (hasWorkshops) {
      // HAS WORKSHOPS - NEEDS PAYMENT
      return reply.code(201).send({
        success: true,
        message: '🎓 SONACSE Registration successful! Complete payment for workshops.',
        registration_type: 'WITH_WORKSHOPS_NEEDS_PAYMENT',
        participant_details: {
          participant_id: participantId,
          participant_name: full_name,
          roll_number: cleanRollNumber, // Return in response only
          department: department,
          college: college_name
        },
        registrations: {
          events: processedEvents, // Already confirmed
          workshops: processedWorkshops, // Pending payment
          total_registrations: processedEvents.length + processedWorkshops.length
        },
        payment: {
          required: true,
          amount: totalAmount,
          payment_reference: paymentReference,
          status: 'PENDING'
        },
        seat_status: {
          message: `✅ ${processedEvents.length} event seats reserved | ⏳ ${processedWorkshops.length} workshop seats pending payment`,
          note: 'Event seats reserved. Workshop seats will be reserved after payment.'
        },
        next_steps: 'Complete payment using the payment reference above to reserve workshop seats.',
        payment_options: {
          upi_id: process.env.UPI_ID || 'threads26@okaxis',
          payment_reference: paymentReference,
          amount: totalAmount
        }
      });
    }
    
  } catch (error) {
    await client.query('ROLLBACK');
    
    // 15. ERROR HANDLING
    const errorMessage = error.message;
    
    if (errorMessage.includes('SONACSE_SEATS_FULL')) {
      return reply.code(400).send({
        success: false,
        error_type: 'SEAT_UNAVAILABLE',
        error_code: 'SONACSE_SEATS_EXHAUSTED',
        message: 'SONACSE seats are full for selected event',
        details: errorMessage.replace('SONACSE_SEATS_FULL: ', ''),
        suggestion: 'Please select different events or contact SONACSE coordinators'
      });
    }
    
    if (errorMessage.includes('INVALID_SONACSE_ROLL')) {
      return reply.code(400).send({
        success: false,
        error_type: 'AUTHENTICATION_ERROR',
        error_code: 'INVALID_SONACSE_ROLL_NUMBER',
        message: 'Invalid SONACSE roll number',
        details: 'The roll number is not in the SONACSE student list',
        suggestion: 'Check your roll number or contact SONACSE coordinators'
      });
    }
    
    return reply.code(400).send({
      success: false,
      error_type: 'REGISTRATION_ERROR',
      error_code: 'UNKNOWN_ERROR',
      message: 'SONACSE registration failed',
      details: errorMessage,
      suggestion: 'Please try again or contact SONACSE support'
    });
    
  } finally {
    client.release();
  }
});

fastify.post('/api/sonacse/verify-payment', async (request, reply) => {
  const client = await pool.connect();
  
  try {
    // 1. VALIDATE INPUT
    const validationErrors = [];
    
    if (!request.body.participant_id) {
      validationErrors.push('PARTICIPANT_ID_REQUIRED: Participant ID is required');
    } else if (isNaN(parseInt(request.body.participant_id)) || parseInt(request.body.participant_id) <= 0) {
      validationErrors.push('PARTICIPANT_ID_INVALID: Participant ID must be a positive number');
    }
    
    if (!request.body.transaction_id || request.body.transaction_id.trim() === '') {
      validationErrors.push('TRANSACTION_ID_REQUIRED: Transaction ID is required');
    }
    
    if (validationErrors.length > 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'INPUT_VALIDATION',
        error_code: 'REQUIRED_FIELDS_MISSING',
        message: 'Please check the following fields:',
        validation_errors: validationErrors.map(err => {
          const [code, message] = err.split(': ');
          return { field_code: code, message };
        })
      });
    }
    
    const {
      participant_id,
      transaction_id,
      payment_reference
    } = request.body;
    
    const participantId = parseInt(participant_id);
    const cleanTransactionId = transaction_id.trim();
    
    // 2. CHECK PARTICIPANT EXISTS AND GET DETAILS
    const participantCheck = await client.query(
      'SELECT participant_id, full_name, department, college_name FROM participants WHERE participant_id = $1',
      [participantId]
    );
    
    if (participantCheck.rows.length === 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'PARTICIPANT_NOT_FOUND',
        error_code: 'INVALID_PARTICIPANT_ID',
        message: 'Participant not found',
        details: `No participant found with ID ${participantId}`,
        suggestion: 'Check the participant ID and try again'
      });
    }
    
    const participant = participantCheck.rows[0];
    
    // 3. CHECK FOR DUPLICATE TRANSACTION
    const duplicateCheck = await client.query(
      'SELECT 1 FROM payments WHERE transaction_id = $1',
      [cleanTransactionId]
    );
    
    if (duplicateCheck.rows.length > 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'DUPLICATE_TRANSACTION',
        error_code: 'TRANSACTION_ALREADY_USED',
        message: 'Transaction ID already used',
        details: 'Please use a different transaction ID',
        transaction_id: cleanTransactionId
      });
    }
    
    // 4. GET PENDING WORKSHOP REGISTRATIONS
    const pendingWorkshops = await client.query(
      `SELECT 
        r.registration_id,
        r.event_id,
        r.registration_unique_id,
        r.amount_paid,
        r.event_name,
        e.day,
        e.cse_available_seats,
        e.available_seats
       FROM registrations r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1 
         AND r.payment_status = 'Pending'
         AND r.amount_paid > 0`,
      [participantId]
    );
    
    if (pendingWorkshops.rows.length === 0) {
      return reply.code(400).send({
        success: false,
        error_type: 'NO_PENDING_WORKSHOPS',
        error_code: 'NO_PAYMENT_REQUIRED',
        message: 'No pending workshops found',
        details: 'This participant has no workshops requiring payment',
        participant_id: participantId,
        participant_name: participant.full_name,
        suggestion: 'Check if payment was already completed'
      });
    }
    
    // 5. CALCULATE TOTAL AMOUNT
    const totalAmount = pendingWorkshops.rows.reduce(
      (sum, reg) => sum + parseFloat(reg.amount_paid || 0),
      0
    );
    
    // 6. START TRANSACTION
    await client.query('BEGIN');
    
    // 7. CHECK AND RESERVE SEATS FOR EACH WORKSHOP
    for (const reg of pendingWorkshops.rows) {
      // Check seat availability
      if (reg.cse_available_seats <= 0) {
        throw new Error(`SONACSE_WORKSHOP_SEATS_FULL: No SONACSE seats available for "${reg.event_name}". Seats filled before payment.`);
      }
      
      // Decrement seats
      await client.query(
        `UPDATE events SET 
          cse_available_seats = cse_available_seats - 1,
          available_seats = available_seats - 1
         WHERE event_id = $1`,
        [reg.event_id]
      );
    }
    
    // 8. SAVE PAYMENT RECORD
    const paymentResult = await client.query(
      `INSERT INTO payments (
        participant_id, 
        transaction_id, 
        payment_reference,
        amount, 
        payment_method, 
        payment_status,
        verified_by_admin,
        verified_at,
        created_at
      ) VALUES ($1, $2, $3, $4, 'UPI', 'Success', false, NOW(), NOW())
      RETURNING payment_id, created_at`,
      [
        participantId,
        cleanTransactionId,
        payment_reference || `SONACSE-PAY-${Date.now().toString().slice(-8)}`,
        totalAmount
      ]
    );
    
    // 9. MARK WORKSHOP REGISTRATIONS AS CONFIRMED
    await client.query(
      `UPDATE registrations
       SET payment_status = 'Success'
       WHERE participant_id = $1 AND payment_status = 'Pending' AND amount_paid > 0
       RETURNING registration_unique_id`,
      [participantId]
    );
    
    // 10. GET ALL CONFIRMED REGISTRATIONS (events + workshops)
    const allRegistrations = await client.query(
      `SELECT registration_unique_id, event_name, amount_paid
       FROM registrations 
       WHERE participant_id = $1 AND payment_status = 'Success'
       ORDER BY registered_at`,
      [participantId]
    );
    
    // 11. COMMIT TRANSACTION
    await client.query('COMMIT');
    
    // 12. GENERATE QR CODE
    const registrationIds = allRegistrations.rows.map(r => r.registration_unique_id);
    
    const qrPayload = {
      participant_id: participantId,
      participant_name: participant.full_name,
      registration_ids: registrationIds,
      event: "THREADS'26",
      type: "SONACSE_FULL_CONFIRMED",
      timestamp: new Date().toISOString()
    };
    
    let qrCodeBase64;
    try {
      qrCodeBase64 = await QRCode.toDataURL(
        JSON.stringify(qrPayload),
        {
          errorCorrectionLevel: 'H',
          type: 'image/png',
          margin: 1,
          width: 250,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        }
      );
    } catch (qrError) {
      console.error('QR generation error:', qrError);
      qrCodeBase64 = null;
    }
    
    // 13. RETURN SUCCESS RESPONSE
    return reply.send({
      success: true,
      message: '✅ SONACSE Payment verified successfully! All seats reserved.',
      participant_details: {
        participant_id: participantId,
        participant_name: participant.full_name,
        department: participant.department || 'CSE',
        college: participant.college_name || 'Sona College of Technology (SONACSE)'
      },
      payment_details: {
        transaction_id: cleanTransactionId,
        amount: totalAmount,
        payment_id: paymentResult.rows[0].payment_id,
        payment_date: paymentResult.rows[0].created_at,
        payment_reference: paymentResult.rows[0].payment_reference
      },
      registrations: {
        total: allRegistrations.rows.length,
        events: allRegistrations.rows.filter(r => r.amount_paid === 0).map(r => ({
          event_name: r.event_name,
          registration_id: r.registration_unique_id,
          fee: 0,
          status: 'Confirmed'
        })),
        workshops: allRegistrations.rows.filter(r => r.amount_paid > 0).map(r => ({
          event_name: r.event_name,
          registration_id: r.registration_unique_id,
          fee: r.amount_paid,
          status: 'Confirmed'
        }))
      },
      qr_code: qrCodeBase64,
      qr_payload: qrPayload,
      next_steps: 'Show QR code at event entry. All registrations confirmed.'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    
    const errorMessage = error.message;
    
    if (errorMessage.includes('SONACSE_WORKSHOP_SEATS_FULL')) {
      return reply.code(400).send({
        success: false,
        error_type: 'SEAT_UNAVAILABLE',
        error_code: 'WORKSHOP_SEATS_FILLED',
        message: 'Workshop seats filled before payment',
        details: errorMessage.replace('SONACSE_WORKSHOP_SEATS_FULL: ', ''),
        suggestion: 'Contact SONACSE coordinators for assistance'
      });
    }
    
    return reply.code(400).send({
      success: false,
      error_type: 'PAYMENT_VERIFICATION_ERROR',
      error_code: 'PROCESSING_ERROR',
      message: 'Payment verification failed',
      details: errorMessage,
      suggestion: 'Please try again or contact SONACSE coordinators'
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
