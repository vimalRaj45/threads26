import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import pg from 'pg';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';
import QRCode from 'qrcode';
import helmet from '@fastify/helmet';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import moment from 'moment';
import axios from 'axios';
import rateLimit from '@fastify/rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const { Pool } = pg;
const fastify = Fastify({ 
  logger: true,
  bodyLimit: 10485760
});

/* -------------------- CORS (PRODUCTION SAFE) -------------------- */
const allowedOrigins = new Set([
  'https://threadscse.co.in'
]);

await fastify.register(cors, {
  origin: (origin, cb) => {
    // Block non-browser requests (curl/postman)
    if (!origin) {
      return cb(new Error('Not allowed by CORS'), false);
    }

    if (allowedOrigins.has(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-KEY'],
  credentials: true
});

await fastify.register(helmet);

/* -------------------- API KEY SECURITY -------------------- */
fastify.addHook('preHandler', async (request, reply) => {

  // Protect only /api routes
  if (!request.url.startsWith('/api')) return;

  // Allow preflight
  if (request.method === 'OPTIONS') return;

  const apiKey = request.headers['x-api-key'];
  const validKey = process.env.API_SECRET_KEY;

  if (!validKey) {
    return reply.code(500).send({
      error: 'Server misconfigured: API_SECRET_KEY missing',
    });
  }

  if (!apiKey || apiKey !== validKey) {
    return reply.code(401).send({
      error: 'Unauthorized: Invalid API key',
    });
  }
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


// After your other plugin registrations
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
});



const EVENT_DATES = {
  registration_closes: moment('2026-03-04', 'YYYY-MM-DD').format('YYYY-MM-DD'),
  workshop_day: moment('2026-03-05', 'YYYY-MM-DD').format('YYYY-MM-DD'),
  event_day: moment('2026-03-06', 'YYYY-MM-DD').format('YYYY-MM-DD')
};


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

fastify.post('/api/send-otp', async (request, reply) => {
  try {
    const { email, name } = request.body;

    if (!email || !name) {
      return reply.code(400).send({
        success: false,
        message: 'Email and name are required'
      });
    }

    // Check if email already registered
    const existing = await pool.query(
      'SELECT 1 FROM participants WHERE LOWER(email)=LOWER($1)',
      [email]
    );
    
    if (existing.rows.length > 0) {
      return reply.code(400).send({
        success: false,
        error: 'EMAIL_EXISTS',
        message: 'This email is already registered'
      });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000);
    
    // Store in Redis with 5 min expiry
    const otpKey = `otp:${email.toLowerCase()}`;
    await redis.setex(otpKey, 300, otp.toString());

    // Send email via Brevo (your existing code)
    const emailResponse = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: {
          email: process.env.SENDER_EMAIL,
          name: process.env.SENDER_NAME || 'ThreadCSE\'26'
        },
        to: [{ email, name }],
        subject: '🔐 OTP Verification - ThreadCSE\'26 Registration',
        htmlContent: `<!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin:0; padding:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f4f7fb;">
            <div style="max-width: 480px; margin: 30px auto; background: #ffffff; border-radius: 28px; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);">
              <div style="height: 8px; background: linear-gradient(90deg, #4158D0, #C850C0, #FFCC70);"></div>
              <div style="padding: 40px 35px;">
                <div style="text-align: center; margin-bottom: 25px;">
                  <span style="font-size: 40px;">🔐</span>
                  <h1 style="color: #1a1e2b; font-size: 24px; font-weight: 700; margin: 10px 0 0;">ThreadCSE'26</h1>
                </div>
                <div style="margin-bottom: 30px;">
                  <h2 style="color: #1a1e2b; font-size: 18px; font-weight: 600; margin: 0 0 5px;">Hello, ${name}!</h2>
                  <p style="color: #4b5565; font-size: 15px; line-height: 1.6; margin: 0;">Use this verification code to complete your registration:</p>
                </div>
                <div style="background: linear-gradient(145deg, #f6f9fc, #ffffff); border-radius: 24px; padding: 25px; text-align: center; margin: 25px 0; border: 2px solid #eef2f6;">
                  <span style="display: inline-block; background: #4158D0; color: white; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 30px; letter-spacing: 0.5px; margin-bottom: 20px;">VERIFICATION CODE</span>
                  <div style="font-size: 48px; font-weight: 700; color: #4158D0; letter-spacing: 8px; font-family: monospace;">${otp}</div>
                  <p style="color: #6b7280; font-size: 13px; margin: 20px 0 0; border-top: 2px dashed #eef2f6; padding-top: 20px;">
                    ⏰ Expires in <strong style="color: #4158D0;">5 minutes</strong>
                  </p>
                </div>
                <div style="background: #f8faff; border-radius: 18px; padding: 20px; margin: 25px 0;">
                  <div style="display: flex; gap: 12px;">
                    <span style="font-size: 22px;">ℹ️</span>
                    <div>
                      <p style="color: #1a1e2b; font-size: 14px; font-weight: 600; margin: 0 0 5px;">Didn't request this?</p>
                      <p style="color: #4b5565; font-size: 13px; line-height: 1.5; margin: 0;">If you didn't attempt to register, please ignore this email.</p>
                    </div>
                  </div>
                </div>
                <div style="text-align: center; margin-top: 30px;">
                  <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                    © 2026 ThreadCSE'26 · All rights reserved<br>
                    <span style="color: #d1d5db;">This is an automated message</span>
                  </p>
                </div>
              </div>
            </div>
          </body>
          </html>` 
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    // FOR TESTING: Return OTP in response (REMOVE IN PRODUCTION)
    return reply.send({
      success: true,
      message: 'OTP sent successfully'
    });

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      success: false,
      message: 'Failed to send OTP'
    });
  }
});



fastify.post('/api/verify-otp', async (request, reply) => {
  try {
    const { email, otp } = request.body;

    console.log('Verifying OTP:', { email, otp }); // Debug log

    if (!email || !otp) {
      return reply.code(400).send({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'Email and OTP are required'
      });
    }

    // Check if email already registered
    const existing = await pool.query(
      'SELECT 1 FROM participants WHERE LOWER(email)=LOWER($1)',
      [email]
    );
    
    if (existing.rows.length > 0) {
      return reply.code(400).send({
        success: false,
        error: 'EMAIL_EXISTS',
        message: 'This email is already registered'
      });
    }

    // Get OTP from Redis
    const otpKey = `otp:${email.toLowerCase()}`;
    const storedOTP = await redis.get(otpKey);
    
    console.log('Stored OTP:', storedOTP, 'Type:', typeof storedOTP);
    console.log('Received OTP:', otp, 'Type:', typeof otp);

    if (!storedOTP) {
      return reply.code(400).send({
        success: false,
        error: 'OTP_EXPIRED',
        message: 'OTP has expired. Please request a new one.'
      });
    }
    
    // IMPORTANT: Convert both to strings for comparison
    if (storedOTP.toString() !== otp.toString()) {
      // Track failed attempts
      const attemptsKey = `otp_attempts:${email.toLowerCase()}`;
      const attempts = await redis.incr(attemptsKey);
      await redis.expire(attemptsKey, 300);
      
      if (attempts >= 5) {
        await redis.del(otpKey);
        return reply.code(400).send({
          success: false,
          error: 'OTP_LOCKED',
          message: 'Too many failed attempts. Please request a new OTP.'
        });
      }
      
      return reply.code(400).send({
        success: false,
        error: 'OTP_INVALID',
        message: 'Invalid OTP. Please try again.',
        attempts_left: 5 - attempts
      });
    }
    
    // OTP verified successfully
    await redis.del(otpKey);
    await redis.del(`otp_attempts:${email.toLowerCase()}`);
    
    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    
    // Store token in Redis with email reference
    const tokenKey = `verify_token:${verificationToken}`;
    await redis.setex(tokenKey, 900, email.toLowerCase()); // 15 minutes

    return reply.send({
      success: true,
      message: 'OTP verified successfully',
      verification_token: verificationToken,
      expires_in: '15 minutes',
      email: email
    });

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({
      success: false,
      error: 'SERVER_ERROR',
      message: 'Failed to verify OTP'
    });
  }
});

fastify.post('/api/register', async (request, reply) => {
    let client = null;

    try {
        const body = request.body;

        // ========== VALIDATION ==========
        if (!body.full_name?.trim()) throw new Error('VALIDATION_FAILED: Full name is required');
        if (!body.email?.trim()) throw new Error('VALIDATION_FAILED: Email is required');
        if (!body.email.includes('@')) throw new Error('VALIDATION_FAILED: Invalid email format');
        
        // VERIFICATION TOKEN CHECK (instead of OTP)
        if (!body.verification_token) {
            throw new Error('VERIFICATION_REQUIRED: Please verify OTP first');
        }
        
        // Verify token from Redis
        const tokenKey = `verify_token:${body.verification_token}`;
        const verifiedEmail = await redis.get(tokenKey);
        
        if (!verifiedEmail) {
            throw new Error('VERIFICATION_EXPIRED: OTP verification expired. Please verify again.');
        }
        
        // Check if token email matches request email
        if (verifiedEmail !== body.email.toLowerCase()) {
            throw new Error('EMAIL_MISMATCH: Verified email does not match registration email');
        }
        
        // Token verified - delete it (one-time use)
        await redis.del(tokenKey);

        // Phone validation
        const cleanPhone = body.phone?.replace(/\D/g, '') || '';
        if (cleanPhone.length < 10) throw new Error('VALIDATION_FAILED: Valid phone required');

        if (!body.college_name?.trim()) throw new Error('VALIDATION_FAILED: College name required');

        const dept = body.department?.trim() || '';
        if (!dept) throw new Error('VALIDATION_FAILED: Department is required');

        const year = parseInt(body.year_of_study);
        if (![1, 2, 3, 4].includes(year)) throw new Error('VALIDATION_FAILED: Year must be 1-4');

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

        // ========== DATABASE OPERATIONS ==========
        client = await pool.connect();
        await client.query('BEGIN');

        // Final duplicate check (race condition prevention)
        const existing = await client.query(
            'SELECT 1 FROM participants WHERE LOWER(email)=LOWER($1)',
            [body.email]
        );
        if (existing.rows.length > 0) throw new Error('EMAIL_EXISTS');

        // Insert participant
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
        let totalAmount = 0;

        // Pricing
        const WORKSHOP_FEE = 400;
        const EVENT_FLAT_FEE = 300;

        // Get all event details
        const allEventIds = [...workshopSelections, ...eventSelections].map(id => parseInt(id));
        const eventDetails = await client.query(
            `SELECT event_id, event_name, fee, day, event_type, available_seats 
             FROM events WHERE event_id = ANY($1::int[]) AND is_active = true`,
            [allEventIds]
        );

        const eventMap = new Map();
        eventDetails.rows.forEach(e => eventMap.set(e.event_id, e));

        // Process workshops
        for (const eventId of workshopSelections) {
            const e = eventMap.get(parseInt(eventId));
            if (!e) throw new Error(`WORKSHOP_NOT_FOUND: ${eventId}`);
            if (e.event_type !== 'workshop') throw new Error(`NOT_A_WORKSHOP: ${eventId}`);
            if (e.available_seats <= 0) throw new Error(`SEATS_FULL: ${e.event_name}`);

            const regId = `THREADS26-WS-${Date.now()}-${eventId}`;

            await client.query(
                `INSERT INTO registrations (participant_id, event_id, registration_unique_id, payment_status, amount_paid, event_name, day)
                 VALUES ($1,$2,$3,'Pending',$4,$5,$6)`,
                [participantId, eventId, regId, WORKSHOP_FEE, e.event_name, e.day]
            );

            registrationIds.push(regId);
            totalAmount += WORKSHOP_FEE;
        }

        // Process events
        let eventFeeAssigned = false;
        for (const eventId of eventSelections) {
            const e = eventMap.get(parseInt(eventId));
            if (!e) throw new Error(`EVENT_NOT_FOUND: ${eventId}`);
            if (e.available_seats <= 0) throw new Error(`SEATS_FULL: ${e.event_name}`);

            const regId = `THREADS26-EV-${Date.now()}-${eventId}`;
            const fee = eventFeeAssigned ? 0 : EVENT_FLAT_FEE;
            if (!eventFeeAssigned) {
                totalAmount += EVENT_FLAT_FEE;
                eventFeeAssigned = true;
            }

            await client.query(
                `INSERT INTO registrations (participant_id, event_id, registration_unique_id, payment_status, amount_paid, event_name, day)
                 VALUES ($1,$2,$3,'Pending',$4,$5,$6)`,
                [participantId, eventId, regId, fee, e.event_name, e.day]
            );

            registrationIds.push(regId);
        }

        await client.query('COMMIT');

        const formattedAmount = parseFloat(totalAmount.toFixed(2));

        return reply.code(201).send({
            success: true,
            message: 'Registration successful!',
            participant_id: participantId,
            participant_name: body.full_name,
            registration_ids: registrationIds,
            workshops_registered: workshopSelections.length,
            events_registered: eventSelections.length,
            total_amount: formattedAmount,
            payment_reference: `THREADS26-${participantId}-${Date.now().toString().slice(-6)}`,
            payment_options: {
                upi_id: process.env.UPI_ID || 'threads26@okaxis',
                amount: formattedAmount
            },
            pricing_info: {
                workshop_fee: WORKSHOP_FEE,
                event_flat_fee: eventSelections.length > 0 ? EVENT_FLAT_FEE : 0,
                note: `₹${WORKSHOP_FEE} per workshop + ₹${EVENT_FLAT_FEE} flat for all events`
            }
        });

    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => { });

        const msg = error.message;
        if (msg.includes('VERIFICATION_REQUIRED')) return reply.code(400).send({ success: false, error: 'VERIFICATION_REQUIRED', details: msg });
        if (msg.includes('VERIFICATION_EXPIRED')) return reply.code(400).send({ success: false, error: 'VERIFICATION_EXPIRED', details: msg });
        if (msg.includes('EMAIL_MISMATCH')) return reply.code(400).send({ success: false, error: 'EMAIL_MISMATCH', details: msg });
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
        } catch (e) { }

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
        await client.query('ROLLBACK').catch(() => { });

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
    const totalAmount = payments.rows.length > 0
    ? payments.rows.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0)
    : registrations.rows.reduce((sum, r) => sum + parseFloat(r.amount_paid || 0), 0);
    
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


    // MUST SELECT AT LEAST ONE EVENT OR ONE WORKSHOP
if (
  (!Array.isArray(event_selections) || event_selections.length === 0) &&
  (!Array.isArray(workshop_selections) || workshop_selections.length === 0)
) {
  throw new Error('SELECTION_REQUIRED: Select at least one event or one workshop');
}
    
    // 2. VALIDATE SONACSE STUDENT - Using only sonacse_students table
    const cleanRoll = roll_number.trim().toUpperCase();
    
    const studentResult = await client.query(
      `SELECT name, registered 
       FROM sonacse_students 
       WHERE regno = $1`,
      [cleanRoll]
    );
    
    if (studentResult.rows.length === 0) {
      throw new Error('INVALID_SONACSE_ROLL: This roll number is not registered in SONACSE student database');
    }
    
    // Check if already registered
    if (studentResult.rows[0].registered === true) {
      throw new Error('ALREADY_REGISTERED: This student has already registered for THREADS 2026');
    }
    
    const studentName = studentResult.rows[0].name;
    
    // 3. CHECK DEADLINE
    if (moment().isAfter(moment(EVENT_DATES.registration_closes))) {
      throw new Error('REGISTRATION_CLOSED');
    }
    
    // 4. CHECK DUPLICATE EMAIL
    const existing = await client.query(
      'SELECT 1 FROM participants WHERE LOWER(email)=LOWER($1)', 
      [email]
    );
    if (existing.rows.length > 0) {
      throw new Error('EMAIL_EXISTS: This email has already been used for registration');
    }
    
    // 5. CALCULATE AMOUNT - FIXED RATES WITH YEAR RULES
    const EVENT_FLAT_RATE = 250;  // Flat rate for 1st year (all events combined)
    const WORKSHOP_DISCOUNTED_RATE = 300;
    
    const eventCount = event_selections.length;
    const workshopCount = workshop_selections.length;
    
    // EVENTS:
    // - 1st year: Flat ₹250 for ALL events combined (regardless of count)
    // - 2nd-4th year: FREE
    const eventsAmount = (year === 1 && eventCount > 0) ? EVENT_FLAT_RATE : 0;
    
    // WORKSHOPS: All years pay ₹300 each
    const workshopsAmount = workshopCount * WORKSHOP_DISCOUNTED_RATE;
    
    const totalAmount = eventsAmount + workshopsAmount;
    const needsPayment = totalAmount > 0;
    
    // 6. INSERT PARTICIPANT
    const participant = await client.query(
      `INSERT INTO participants (full_name, email, phone, college_name, department, year_of_study, gender) 
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING participant_id`,
      [studentName, email.toLowerCase(), phone.replace(/\D/g,''), 
       'Sona College of Technology (SONACSE)', 'CSE', year, gender || 'Not Specified']
    );
    
    const participantId = participant.rows[0].participant_id;

    // 7. UPDATE SONACSE STUDENT REGISTRATION STATUS
    await client.query(
      `UPDATE sonacse_students
       SET registered = true
       WHERE regno = $1`,
      [cleanRoll]
    );
    
    const registrationIds = [];
    
    // 8. PROCESS EVENTS & WORKSHOPS
    const processEvent = async (eventId, type) => {
      const event = await client.query(
        `SELECT event_id, event_name, day, cse_available_seats, event_type 
         FROM events WHERE event_id=$1 AND is_active=true`, 
        [eventId]
      );
      
      if (!event.rows[0]) throw new Error(`EVENT_NOT_FOUND: ${eventId}`);
      if (event.rows[0].cse_available_seats <= 0) throw new Error(`SEATS_FULL: ${event.rows[0].event_name}`);
      
      const regId = `THREADS26-SONA-${Date.now()}-${eventId}`;
      
      // Determine amount based on type AND year
      let amount = 0;
      if (type === 'workshop') {
        // All years pay for workshops
        amount = WORKSHOP_DISCOUNTED_RATE;
      } else { // event
        // For 1st year: Even though they pay a flat ₹250 total,
        // we need to distribute the payment across events
        // Since they're paying a flat rate, set individual event amount to 0
        // The total eventsAmount (₹250) will be handled as a package
        amount = 0; // Individual events show as ₹0 since it's a package deal
      }
      
      // Payment status: For 1st year events, we'll mark them all with the same payment reference
      // For workshops: 'Pending' if amount > 0, 'Success' if free (never happens for workshops)
let status;
if (type === 'workshop') {
    status = 'Pending'; // All years pay for workshops
} else {
    status = (year === 1) ? 'Pending' : 'Success'; // 1st year pays, others free
}
      
      await client.query(
        `INSERT INTO registrations (participant_id, event_id, registration_unique_id, payment_status, amount_paid, event_name, day)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [participantId, eventId, regId, status, amount, event.rows[0].event_name, event.rows[0].day]
      );
      
      // Decrement seats
      await client.query(
        `UPDATE events SET cse_available_seats = cse_available_seats - 1, available_seats = available_seats - 1
         WHERE event_id = $1`, 
        [eventId]
      );
      
      registrationIds.push(regId);
      return { 
        event_id: eventId, 
        event_name: event.rows[0].event_name, 
        registration_id: regId,
        amount: amount,
        type: type,
        payment_status: status
      };
    };
    
    // Process all selections
    const processedEvents = await Promise.all(event_selections.map(id => processEvent(parseInt(id), 'event')));
    const processedWorkshops = await Promise.all(workshop_selections.map(id => processEvent(parseInt(id), 'workshop')));
    
    await client.query('COMMIT');
    
    // 9. GENERATE QR PAYLOAD if no payment needed
    let qrCodeBase64 = null;
    if (!needsPayment) {
      const qrPayload = {
        pid: participantId,
        ids: registrationIds.join('|')
      };
      
      qrCodeBase64 = await QRCode.toDataURL(JSON.stringify(qrPayload), {
        errorCorrectionLevel: 'L', margin: 0, width: 200
      }).catch(() => null);
    }
    
    // 10. RESPONSE
    return reply.code(201).send({
      success: true,
      participant_id: participantId,
      name: studentName,
      roll_number: cleanRoll,
      year: year,
      events: processedEvents.length,
      workshops: processedWorkshops.length,
      event_rate: year === 1 ? EVENT_FLAT_RATE : 0,
      workshop_rate: WORKSHOP_DISCOUNTED_RATE,
      events_amount: eventsAmount,
      workshops_amount: workshopsAmount,
      total_amount: totalAmount,
      needs_payment: needsPayment,
      qr: qrCodeBase64,
      reg_ids: registrationIds,
      payment_ref: needsPayment ? `SONA-${participantId}-${Date.now()}` : null,
      breakdown: {
        events: processedEvents.map(e => ({ 
          name: e.event_name, 
          amount: e.amount,
          status: e.payment_status 
        })),
        workshops: processedWorkshops.map(w => ({ 
          name: w.event_name, 
          amount: w.amount,
          status: w.payment_status 
        }))
      },
      message: year === 1 
        ? "1st Year: Flat ₹250 for ALL events + ₹300 per workshop" 
        : "2nd-4th Year: Events FREE, Pay ₹300 per workshop"
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
    
    // 2. CHECK PARTICIPANT
    const participant = await client.query(
      'SELECT participant_id, full_name, year_of_study FROM participants WHERE participant_id = $1',
      [participantId]
    );
    if (participant.rows.length === 0) throw new Error('PARTICIPANT_NOT_FOUND');
    
    const year = parseInt(participant.rows[0].year_of_study);
    
    // 3. CHECK DUPLICATE TRANSACTION
    const duplicate = await client.query('SELECT 1 FROM payments WHERE transaction_id = $1', [transaction_id]);
    if (duplicate.rows.length > 0) throw new Error('DUPLICATE_TRANSACTION');
    
    // 4. GET ALL REGISTRATIONS WITH THEIR STATUS - REMOVED event_type reference
    const registrations = await client.query(
      `SELECT r.event_id, r.registration_unique_id, r.event_name, r.amount_paid, r.payment_status,
              e.cse_available_seats
       FROM registrations r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.participant_id = $1
       ORDER BY r.registered_at`,
      [participantId]
    );
    
    if (registrations.rows.length === 0) {
      throw new Error('NO_REGISTRATIONS_FOUND');
    }
    
    // 5. CHECK IF ANY REGISTRATIONS ARE PENDING
    const pendingRegs = registrations.rows.filter(r => r.payment_status === 'Pending');
    
    if (pendingRegs.length === 0) {
      throw new Error('ALL_REGISTRATIONS_ALREADY_PAID: No pending payments');
    }
    
    // 6. DETERMINE EVENT TYPES - Since we don't have event_type column, 
    // we need to determine type from event_id or event_name
    // For now, let's assume we need to know which are workshops vs events
    // You might need to fetch this from another source or have a different approach
    
    // Option 1: If you have a separate workshops table or can identify by event_id range
    // For example, if workshop IDs are > 100 or something
    const workshopIds = [/* Add your workshop IDs here */]; // You need to populate this
    
    const pendingWorkshops = pendingRegs.filter(r => workshopIds.includes(r.event_id));
    const pendingEvents = pendingRegs.filter(r => !workshopIds.includes(r.event_id));
    
    // For logging only
    let expectedTotal = 0;
    expectedTotal += pendingWorkshops.length * 300;
    
    if (year === 1) {
      const confirmedEvents = registrations.rows.filter(r => 
        !workshopIds.includes(r.event_id) && r.payment_status === 'Success'
      );
      
      if (confirmedEvents.length > 0 && pendingEvents.length > 0) {
        console.log('First year student with confirmed events - pending events are free');
      } 
      else if (pendingEvents.length > 0) {
        expectedTotal += 250;
      }
    }
    
    console.log('Payment calculation (for reference only):', {
      year,
      pendingWorkshops: pendingWorkshops.length,
      pendingEvents: pendingEvents.length,
      confirmedEvents: registrations.rows.filter(r => !workshopIds.includes(r.event_id) && r.payment_status === 'Success').length,
      expectedTotal,
      receivedAmount: amount
    });
    
    // 7. START TRANSACTION
    await client.query('BEGIN');
    
    // 8. CHECK SEAT AVAILABILITY FOR PENDING REGISTRATIONS
    for (const reg of pendingRegs) {
      const seatCheck = await client.query(
        'SELECT cse_available_seats FROM events WHERE event_id = $1',
        [reg.event_id]
      );
      
      if (seatCheck.rows[0].cse_available_seats <= 0) {
        throw new Error(`SEATS_FULL: ${reg.event_name}`);
      }
    }
    
    // 9. DECREMENT SEATS FOR PENDING REGISTRATIONS
    for (const reg of pendingRegs) {
      await client.query(
        `UPDATE events SET 
           cse_available_seats = cse_available_seats - 1, 
           available_seats = available_seats - 1
         WHERE event_id = $1`, 
        [reg.event_id]
      );
    }
    
    // 10. SAVE PAYMENT
    const paymentResult = await client.query(
      `INSERT INTO payments (participant_id, transaction_id, amount, payment_status, verified_by_admin)
       VALUES ($1, $2, $3, 'Success', false)
       RETURNING payment_id`,
      [participantId, transaction_id, parseFloat(amount)]
    );
    
    // 11. MARK ALL PENDING REGISTRATIONS AS CONFIRMED
    await client.query(
      `UPDATE registrations SET payment_status = 'Success'
       WHERE participant_id = $1 AND payment_status = 'Pending'`,
      [participantId]
    );
    
    await client.query('COMMIT');
    
    // 12. GET UPDATED REGISTRATIONS FOR RESPONSE
    const updatedRegs = await client.query(
      `SELECT registration_unique_id, amount_paid, payment_status, event_name, event_id
       FROM registrations 
       WHERE participant_id = $1 
       ORDER BY registered_at`,
      [participantId]
    );
    
    const registrationIds = updatedRegs.rows.map(r => r.registration_unique_id);
    
    // Separate by type for response (using same workshopIds logic)
    const workshops = updatedRegs.rows.filter(r => workshopIds.includes(r.event_id));
    const events = updatedRegs.rows.filter(r => !workshopIds.includes(r.event_id));
    
    // Calculate total paid so far
    const totalPaymentsResult = await client.query(
      'SELECT SUM(amount) as total_paid FROM payments WHERE participant_id = $1',
      [participantId]
    );
    const totalPaid = parseFloat(totalPaymentsResult.rows[0]?.total_paid || 0);
    
    // 13. GENERATE QR
    const qrPayload = {
      pid: participantId,
      ids: registrationIds.join('|')
    };
    
    const qrCode = await QRCode.toDataURL(JSON.stringify(qrPayload), {
      errorCorrectionLevel: 'L', margin: 0, width: 200
    }).catch(() => null);
    
    // 14. RESPONSE
    return reply.send({
      success: true,
      participant_id: participantId,
      name: participant.rows[0].full_name,
      year: year,
      amount_paid_this_transaction: parseFloat(amount),
      total_paid: totalPaid,
      payment_id: paymentResult.rows[0].payment_id,
      transaction_id: transaction_id,
      breakdown: {
        workshops: {
          count: workshops.length,
          amount: workshops.length * 300,
          items: workshops.map(w => ({
            name: w.event_name,
            amount: 300,
            registration_id: w.registration_unique_id
          }))
        },
        events: {
          count: events.length,
          amount: (year === 1 && events.length > 0 && totalPaid <= 250) ? 250 : 0,
          items: events.map(e => ({
            name: e.event_name,
            amount: 0,
            registration_id: e.registration_unique_id
          }))
        }
      },
      summary: {
        total_registrations: updatedRegs.rows.length,
        workshops_confirmed: workshops.length,
        events_confirmed: events.length,
        confirmed_now: pendingRegs.length
      },
      qr_code: qrCode,
      registration_ids: registrationIds,
      message: year === 1 
        ? events.length > 0 && workshops.length > 0
          ? totalPaid > 250
            ? `Payment verified: ₹${workshops.length * 300} for ${workshops.length} workshop(s) (events already paid in previous transaction)`
            : `Payment verified: ₹250 for ${events.length} event(s) + ₹${workshops.length * 300} for ${workshops.length} workshop(s)`
          : events.length > 0
            ? `Payment verified: ₹250 for ${events.length} event(s)`
            : `Payment verified: ₹${workshops.length * 300} for ${workshops.length} workshop(s)`
        : `Payment verified: ₹${workshops.length * 300} for ${workshops.length} workshop(s) (events are free)`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    fastify.log.error(error);
    
    console.error('Payment verification error:', {
      message: error.message,
      stack: error.stack,
      body: request.body
    });

    if (error.message.includes('ALL_REGISTRATIONS_ALREADY_PAID')) {
      return reply.code(400).send({
        success: false,
        error: 'ALREADY_PAID',
        details: 'All registrations are already paid. No pending payments found.'
      });
    }
    
    if (error.message.includes('NO_REGISTRATIONS_FOUND')) {
      return reply.code(400).send({
        success: false,
        error: 'NO_REGISTRATIONS',
        details: 'No registrations found for this participant'
      });
    }
    
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
      host: '0.0.0.0' 
    });

    console.log(`🚀 Server running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
