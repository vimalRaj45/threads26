import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import pg from 'pg';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import moment from 'moment';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const { Pool } = pg;

// ==================== STRESS & CONCURRENCY OPTIMIZATIONS ====================

// 1. Enhanced Connection Pool with connection reuse
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_AfPar8WIF1jl@ep-late-unit-aili6pkq-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 100, // Increased for concurrency
  min: 20, // Keep minimum connections ready
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// 2. Fastify with concurrency optimizations
const fastify = Fastify({ 
  logger: {
    level: 'info',
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          hostname: request.hostname,
          remoteAddress: request.ip,
        };
      }
    }
  },
  bodyLimit: 10485760,
  connectionTimeout: 10000, // Connection timeout
  keepAliveTimeout: 5000,   // Keep-alive timeout
  maxRequestsPerSocket: 100, // Limit requests per connection
  disableRequestLogging: true, // Disable for performance
});

// 3. Redis with connection pooling
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

// 4. Rate Limiting Middleware
const rateLimitStore = new Map();
const RATE_LIMIT = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100 // Max requests per IP
};

// Add rate limiting hook
fastify.addHook('onRequest', async (request, reply) => {
  // Skip rate limiting for health checks
  if (request.url === '/api/health') return;
  
  const ip = request.ip;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT.windowMs;
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }
  
  const requests = rateLimitStore.get(ip).filter(time => time > windowStart);
  
  if (requests.length >= RATE_LIMIT.maxRequests) {
    reply.code(429).send({
      error: 'Too many requests',
      retryAfter: Math.ceil((requests[0] + RATE_LIMIT.windowMs - now) / 1000)
    });
    return;
  }
  
  requests.push(now);
  rateLimitStore.set(ip, requests);
});

// 5. Request Queue for High Traffic Endpoints
const requestQueue = {
  registrations: [],
  payments: [],
  isProcessing: false
};

const processQueue = async (queueType) => {
  if (requestQueue.isProcessing) return;
  
  requestQueue.isProcessing = true;
  const queue = requestQueue[queueType];
  
  while (queue.length > 0) {
    const { request, reply, handler } = queue.shift();
    try {
      await handler(request, reply);
    } catch (error) {
      console.error('Queue processing error:', error);
    }
  }
  
  requestQueue.isProcessing = false;
};

// 6. Database Connection Pool Monitor
let dbConnectionErrors = 0;
const MAX_DB_ERRORS = 10;

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  dbConnectionErrors++;
  
  if (dbConnectionErrors > MAX_DB_ERRORS) {
    console.error('High database error rate. Consider restarting.');
  }
});

pool.on('connect', () => {
  dbConnectionErrors = Math.max(0, dbConnectionErrors - 1);
});

// 7. CACHE FUNCTIONS (ADD THIS)
const cacheWithTTL = async (key, data, ttl = 60) => {
  try {
    await redis.setex(key, ttl, JSON.stringify(data));
  } catch (error) {
    console.error('Cache set error:', error);
  }
};

const getCached = async (key) => {
  try {
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.error('Cache get error:', error);
    return null;
  }
};

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

const invalidateParticipantCache = async (participantId) => {
  await redis.del(`verification:${participantId}`);
  await invalidateCache(`track:*`);
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

const invalidateEventsCache = async () => {
  await invalidateCache('events:*');
  await invalidateCache('seats:*');
};

// 8. Connection Pool Middleware
fastify.addHook('onRequest', async (request, reply) => {
  // Attach pool to request for reuse
  request.pool = pool;
  request.redis = redis;
});

// Event dates (for auto-close feature)
const EVENT_DATES = {
  workshop_day: moment().add(5, 'days').format('YYYY-MM-DD'),
  event_day: moment().add(6, 'days').format('YYYY-MM-DD'),
  registration_closes: moment().add(4, 'days').format('YYYY-MM-DD')
};

// ==================== HEALTH ENDPOINT WITH LOAD CHECK ====================

fastify.get('/api/health', async () => {
  const startTime = Date.now();
  
  // Parallel health checks
  const [dbHealth, redisHealth, queueLength] = await Promise.all([
    pool.query('SELECT 1 as healthy').catch(() => ({ rows: [{ healthy: 0 }] })),
    redis.ping().then(() => 'OK').catch(() => 'ERROR'),
    Promise.resolve(requestQueue.registrations.length + requestQueue.payments.length)
  ]);
  
  const responseTime = Date.now() - startTime;
  
  return {
    status: 'operational',
    timestamp: new Date().toISOString(),
    response_time_ms: responseTime,
    services: {
      database: dbHealth.rows[0].healthy === 1 ? 'OK' : 'ERROR',
      redis: redisHealth,
      registration_open: moment().isBefore(moment(EVENT_DATES.registration_closes))
    },
    load: {
      active_connections: pool.totalCount,
      idle_connections: pool.idleCount,
      waiting_connections: pool.waitingCount,
      queue_length: queueLength
    }
  };
});

const sendEmail = async (to, subject, html) => {
  console.log(`Email to ${to}: ${subject}`);
  return true;
};

const sendWhatsApp = async (phone, message) => {
  console.log(`WhatsApp to ${phone}: ${message}`);
  return true;
};

// ==================== PLUGIN REGISTRATION ====================

await fastify.register(cors, { origin: '*' });
await fastify.register(formbody);
await fastify.register(multipart);
await fastify.register(staticPlugin, {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
});

// ==================== OPTIMIZED API ROUTES ====================

// 1. Get Event Dates & Countdown (Cached)
fastify.get('/api/event-dates', async () => {
  const cacheKey = 'event_dates';
  const cached = await getCached(cacheKey);
  
  if (cached) {
    return cached;
  }
  
  const today = moment();
  const workshopDate = moment(EVENT_DATES.workshop_day);
  const eventDate = moment(EVENT_DATES.event_day);
  
  const response = {
    workshop_day: EVENT_DATES.workshop_day,
    event_day: EVENT_DATES.event_day,
    registration_closes: EVENT_DATES.registration_closes,
    countdown: {
      days_to_workshop: workshopDate.diff(today, 'days'),
      days_to_event: eventDate.diff(today, 'days'),
      is_registration_open: today.isBefore(moment(EVENT_DATES.registration_closes))
    }
  };
  
  await cacheWithTTL(cacheKey, response, 300); // Cache for 5 minutes
  return response;
});

// 2. Get Events (Cached)
fastify.get('/api/events', async (request, reply) => {
  try {
    const { day, type } = request.query;
    const cacheKey = `events:${day || 'all'}:${type || 'all'}`;
    
    const cached = await getCached(cacheKey);
    if (cached) {
      return cached;
    }
    
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

    const response = {
      events: result.rows,
      registration_open: moment().isBefore(moment(EVENT_DATES.registration_closes))
    };
    
    await cacheWithTTL(cacheKey, response, 60); // Cache for 1 minute
    
    return response;

  } catch (error) {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Failed to fetch events' });
  }
});

// 3. QUEUED REGISTRATION ENDPOINT (Optimized for concurrency)
fastify.post('/api/register', async (request, reply) => {
  return new Promise((resolve, reject) => {
    // Add to queue instead of processing immediately
    requestQueue.registrations.push({
      request,
      reply,
      handler: async (req, rep) => {
        await handleRegistration(req, rep);
      }
    });
    
    // Process queue
    processQueue('registrations');
    
    // Immediate response
    rep.code(202).send({
      success: true,
      message: 'Registration request received. Processing in queue...',
      queue_position: requestQueue.registrations.length,
      estimated_wait: Math.min(requestQueue.registrations.length * 2, 30) // seconds
    });
    
    resolve();
  });
});

// Original registration handler (unchanged)
const handleRegistration = async (request, reply) => {
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
    
    // 3. CHECK FOR DUPLICATE EMAIL (with cache)
    const emailCacheKey = `email_check:${email.toLowerCase()}`;
    const cachedEmailCheck = await getCached(emailCacheKey);
    
    if (!cachedEmailCheck) {
      const existing = await client.query(
        'SELECT * FROM participants WHERE LOWER(email) = LOWER($1)',
        [email]
      );
      
      if (existing.rows.length > 0) {
        await cacheWithTTL(emailCacheKey, { exists: true }, 60);
        throw new Error('EMAIL_EXISTS: This email is already registered. Please use a different email.');
      }
      await cacheWithTTL(emailCacheKey, { exists: false }, 60);
    } else if (cachedEmailCheck.exists) {
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
    
    // 6. DEFINE SEAT CHECK FUNCTION (Optimized with cache)
    const checkSeatAvailability = async (eventId, department) => {
      const cacheKey = `seats:${eventId}`;
      const cached = await getCached(cacheKey);
      
      if (cached) {
        const eventData = cached;
        
        if (department === 'CSE') {
          if (eventData.cse_available_seats <= 0) {
            throw new Error(`CSE_SEATS_FULL: No CSE seats available for event ID ${eventId}. CSE seats: ${eventData.cse_available_seats}/${eventData.cse_seats}`);
          }
        } else {
          if (eventData.available_seats <= 0) {
            throw new Error(`GENERAL_SEATS_FULL: No general seats available for event ID ${eventId}. General seats: ${eventData.available_seats}/${eventData.total_seats}`);
          }
        }
        return true;
      }
      
      // Fallback to DB
      const event = await client.query(
        'SELECT * FROM events WHERE event_id = $1 AND is_active = true',
        [eventId]
      );
      
      if (!event.rows[0]) {
        throw new Error(`EVENT_NOT_FOUND: Event ID ${eventId} not found or inactive`);
      }
      
      const eventData = event.rows[0];
      
      // Cache the seat data
      await cacheWithTTL(cacheKey, eventData, 30);
      
      if (department === 'CSE') {
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
    
    // 7. PROCESS WORKSHOPS
    const processedWorkshops = [];
    for (const eventId of workshop_selections) {
      const eventIdNum = parseInt(eventId);
      if (isNaN(eventIdNum) || eventIdNum <= 0) {
        throw new Error(`INVALID_WORKSHOP_ID: Workshop ID "${eventId}" is invalid`);
      }
      
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
      
      await checkSeatAvailability(eventId, department);
      
      const prefix = 'THREADS26-WS-';
      const deptCode = department === 'CSE' ? 'CSE' : 'OTH';
      const timestamp = Date.now().toString().slice(-9);
      const baseRegId = `${prefix}${deptCode}-${timestamp}`;
      const regId = `${baseRegId}-${eventId}`;
      
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          participantId,
          eventId,
          regId,
          'Pending',
          parseFloat(event.rows[0].fee) || 0,
          event.rows[0].event_name,
          event.rows[0].day
        ]
      );
      
      registrationIds.push(regId);
      totalAmount += parseFloat(event.rows[0].fee) || 0;
      processedWorkshops.push(eventId);
    }
    
    // 8. PROCESS EVENTS
    const processedEvents = [];
    for (const eventId of event_selections) {
      const eventIdNum = parseInt(eventId);
      if (isNaN(eventIdNum) || eventIdNum <= 0) {
        throw new Error(`INVALID_EVENT_ID: Event ID "${eventId}" is invalid`);
      }
      
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
      
      await checkSeatAvailability(eventId, department);
      
      const prefix = 'THREADS26-EV-';
      const deptCode = department === 'CSE' ? 'CSE' : 'OTH';
      const timestamp = Date.now().toString().slice(-9);
      const baseRegId = `${prefix}${deptCode}-${timestamp}`;
      const regId = `${baseRegId}-${eventId}`;
      
      await client.query(
        `INSERT INTO registrations (
          participant_id, event_id, registration_unique_id,
          payment_status, amount_paid, event_name, day
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          participantId,
          eventId,
          regId,
          'Pending',
          parseFloat(event.rows[0].fee) || 0,
          event.rows[0].event_name,
          event.rows[0].day
        ]
      );
      
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
};

// 4. QUEUED PAYMENT VERIFICATION (Optimized)
fastify.post('/api/verify-payment', async (request, reply) => {
  return new Promise((resolve, reject) => {
    requestQueue.payments.push({
      request,
      reply,
      handler: async (req, rep) => {
        await handlePaymentVerification(req, rep);
      }
    });
    
    processQueue('payments');
    
    rep.code(202).send({
      success: true,
      message: 'Payment verification request received. Processing in queue...',
      queue_position: requestQueue.payments.length,
      estimated_wait: Math.min(requestQueue.payments.length * 1, 20) // seconds
    });
    
    resolve();
  });
});

// Original payment verification handler (unchanged)
const handlePaymentVerification = async (request, reply) => {
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
    
    // 8. DEFINE SEAT UPDATE FUNCTION
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
      const lockKey = `seat_lock:${reg.event_id}:${Date.now()}`;
      const lockAcquired = await redis.set(lockKey, 'locked', { nx: true, ex: 3 });
      if (!lockAcquired) {
        throw new Error(`Event ${reg.event_id} is being processed. Please try again.`);
      }
      seatLocks.push(lockKey);
      
      const event = await client.query(
        'SELECT event_name, cse_available_seats, available_seats FROM events WHERE event_id = $1 AND is_active = true',
        [reg.event_id]
      );
      
      if (event.rows.length === 0) {
        throw new Error(`Event ${reg.event_id} not found or inactive`);
      }
      
      const eventData = event.rows[0];
      
      if (department === 'CSE') {
        if (eventData.cse_available_seats <= 0) {
          throw new Error(`CSE_SEATS_FULL_AT_PAYMENT: No CSE seats available for "${reg.event_name}". Seats filled before payment.`);
        }
      } else {
        if (eventData.available_seats <= 0) {
          throw new Error(`GENERAL_SEATS_FULL_AT_PAYMENT: No general seats available for "${reg.event_name}". Seats filled before payment.`);
        }
      }
      
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
    
    if (qrCodeBase64) {
      response.qr_code = qrCodeBase64;
      response.qr_payload = qrPayload;
    }
    
    return reply.send(response);
    
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback error:', rollbackError);
    }
    
    const errorMessage = error.message;
    
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
    client.release();
  }
};

// 5. ADMIN PAYMENT VERIFICATION (Optimized with cache invalidation)
fastify.post("/api/admin/verify-payments", async (request, reply) => {
  const client = await pool.connect();

  try {
    const { payments } = request.body;

    if (!Array.isArray(payments) || payments.length === 0) {
      return reply.code(400).send({ error: "payments array required" });
    }

    const verified = [];
    const failed = [];

    await client.query("BEGIN");

    for (const row of payments) {
      const { transaction_id, amount } = row;

      if (!transaction_id || amount == null) {
        failed.push({ transaction_id, reason: "Invalid data" });
        continue;
      }

      const result = await client.query(
        `UPDATE payments
         SET verified_by_admin = true,
             verified_at = NOW(),
             payment_status = 'Success'
         WHERE transaction_id = $1
           AND amount = $2
         RETURNING payment_id`,
        [transaction_id, amount]
      );

      if (result.rowCount > 0) {
        verified.push(transaction_id);
      } else {
        failed.push({ transaction_id, reason: "No match found" });
      }
    }

    await client.query("COMMIT");

    // Clear relevant caches
    await Promise.all([
      redis.del('admin_stats'),
      invalidateCache('^track:.*'),
      invalidateCache('^verification:.*'),
      invalidateCache('events:*')
    ]);

    return {
      success: true,
      verified_count: verified.length,
      failed_count: failed.length,
      verified,
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

// 6. ADMIN LOGIN (No changes needed)
fastify.post('/api/admin/login', async (request, reply) => {
  const { username, password } = request.body;
  
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

// 7. ADMIN REGISTRATIONS (Cached)
fastify.get('/api/admin/registrations', async (request) => {
  try {
    const { page = 1, limit = 50, event_id, payment_status } = request.query;
    const offset = (page - 1) * limit;
    
    const cacheKey = `admin_reg:${page}:${limit}:${event_id || 'all'}:${payment_status || 'all'}`;
    const cached = await getCached(cacheKey);
    if (cached) return cached;

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

    await cacheWithTTL(cacheKey, rows, 30); // Cache for 30 seconds
    
    return rows;

  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 8. MANUAL PAYMENT VERIFICATION (Optimized with cache invalidation)
fastify.post('/api/admin/manual-verification', async (request, reply) => {
  const client = await pool.connect();

  try {
    const { participant_id } = request.body;

    if (!participant_id) {
      return reply.code(400).send({ error: 'participant_id is required' });
    }

    await client.query('BEGIN');

    // 1️⃣ Ensure participant exists
    const participantCheck = await client.query(
      `SELECT participant_id FROM participants WHERE participant_id = $1`,
      [participant_id]
    );

    if (participantCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'Participant not found' });
    }

    // 2️⃣ Insert manual payment verification
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
      RETURNING payment_id`,
      [
        participant_id,
        `MANUAL-${Date.now()}`,
        0,
        'Manual Verification',
        'Success',
        true,
        'Manually verified by admin'
      ]
    );

    // 3️⃣ Update registrations payment status
    await client.query(
      `UPDATE registrations
       SET payment_status = 'Success'
       WHERE participant_id = $1`,
      [participant_id]
    );

    await client.query('COMMIT');

    // Clear caches
    await Promise.all([
      invalidateParticipantCache(participant_id),
      invalidateStatsCache(),
      invalidateEventsCache()
    ]);

    return {
      success: true,
      message: 'Participant manually verified',
      participant_id,
      payment_id: paymentResult.rows[0].payment_id
    };

  } catch (error) {
    await client.query('ROLLBACK');
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Manual verification failed' });
  } finally {
    client.release();
  }
});

// 9. ADMIN QR SCAN (No changes needed)
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

// 10. UPDATE ATTENDANCE (Optimized with cache invalidation)
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

    // Clear cache
    await invalidateStatsCache();

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

// 11. ATTENDANCE REPORT (Cached)
fastify.get('/api/admin/attendance-report', async (request) => {
  // Verify admin token
  const adminToken = request.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    throw new Error('Unauthorized');
  }
  
  try {
    const { event_id, day, date } = request.query;
    
    const cacheKey = `attendance_report:${event_id || 'all'}:${day || 'all'}:${date || 'all'}`;
    const cached = await getCached(cacheKey);
    if (cached) return cached;
    
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
    
    const response = {
      registrations: result.rows,
      statistics: stats
    };
    
    await cacheWithTTL(cacheKey, response, 30); // Cache for 30 seconds
    
    return response;
    
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 12. BULK ATTENDANCE UPDATE (Optimized with cache invalidation)
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
    
    // Clear cache
    await invalidateStatsCache();
    
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

// 13. EXPORT REGISTRATIONS (Cached data query)
fastify.get('/api/admin/export', async (request, reply) => {
  // Verify admin token
  const adminToken = request.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  
  try {
    const cacheKey = 'export_data';
    const cached = await getCached(cacheKey);
    
    let result;
    if (cached) {
      result = { rows: cached };
    } else {
      result = await pool.query(`
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
      
      // Cache the data (not the CSV) for 30 seconds
      await cacheWithTTL(cacheKey, result.rows, 30);
    }
    
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

// 14. PARTICIPANT VERIFICATION STATUS (Cached)
fastify.get('/api/participant/:id/verification-status', async (request, reply) => {
  try {
    const { id } = request.params;
    const cacheKey = `verification:${id}`;
    
    // Try cache first
    const cached = await getCached(cacheKey);
    if (cached) {
      return cached;
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
    await cacheWithTTL(cacheKey, response, 30);
    
    return response;
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// 15. TRACK REGISTRATION (Cached)
fastify.get('/api/track/:registration_id', async (request, reply) => {
  try {
    const { registration_id } = request.params;
    const cacheKey = `track:${registration_id}`;
    
    // Try cache first
    const cached = await getCached(cacheKey);
    if (cached) {
      return cached;
    }
    
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
    
    const response = {
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
      }
    };
    
    // Cache for 60 seconds
    await cacheWithTTL(cacheKey, response, 60);
    
    return response;
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// 16. ADMIN STATS (Cached)
fastify.get('/api/admin/stats', async (request) => {
  const cacheKey = 'admin_stats';
  
  // Try cache first
  const cached = await getCached(cacheKey);
  if (cached) {
    return cached;
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
    
    // Cache for 60 seconds
    await cacheWithTTL(cacheKey, result, 60);
    
    return result;
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 17. UPDATE EVENT STATUS (Optimized with cache invalidation)
fastify.patch('/api/admin/events/:id', async (request, reply) => {
  
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
    
    // Clear events cache
    await invalidateEventsCache();
    
    return { 
      success: true, 
      event: result.rows[0] 
    };
    
  } catch (error) {
    fastify.log.error(error);
    return reply.code(400).send({ error: error.message });
  }
});

// 18. UPLOAD GALLERY IMAGE (Optimized with cache invalidation)
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
    
    // Clear gallery cache
    await invalidateGalleryCache();
    
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

// 19. GET GALLERY IMAGES (Cached)
fastify.get('/api/gallery', async (request) => {
  try {
    const { album_name } = request.query;
    const cacheKey = `gallery:${album_name || 'all'}`;
    
    const cached = await getCached(cacheKey);
    if (cached) return cached;
    
    let query = 'SELECT * FROM gallery ORDER BY uploaded_at DESC';
    const params = [];
    
    if (album_name) {
      query = 'SELECT * FROM gallery WHERE album_name = $1 ORDER BY uploaded_at DESC';
      params.push(album_name);
    }
    
    const result = await pool.query(query, params);
    
    await cacheWithTTL(cacheKey, result.rows, 300); // Cache for 5 minutes
    
    return result.rows;
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 20. CREATE ANNOUNCEMENT (Optimized with cache invalidation)
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
    
    // Clear announcements cache
    await invalidateAnnouncementsCache();
    
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

// 21. GET ACTIVE ANNOUNCEMENTS (Cached)
fastify.get('/api/announcements', async () => {
  try {
    const cacheKey = 'announcements';
    const cached = await getCached(cacheKey);
    if (cached) return cached;
    
    const result = await pool.query(
      `SELECT * FROM announcements 
       WHERE is_active = true AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`
    );
    
    await cacheWithTTL(cacheKey, result.rows, 120); // Cache for 2 minutes
    
    return result.rows;
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 22. GET QR FOR PARTICIPANT (Cached)
fastify.get('/api/participant/:id/qr-data', async (request) => {
  try {
    const { id } = request.params;
    const cacheKey = `qr_data:${id}`;
    
    const cached = await getCached(cacheKey);
    if (cached) return cached;
    
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
    
    const response = {
      participant: participant.rows[0],
      registrations: registrations.rows,
      payments: payments.rows,
      total_amount: totalAmount,
      qr_url: `/api/participant/${id}/qr`
    };
    
    await cacheWithTTL(cacheKey, response, 30); // Cache for 30 seconds
    
    return response;
    
  } catch (error) {
    fastify.log.error(error);
    throw error;
  }
});

// 23. AUTO-CLOSE REGISTRATION CHECK (No cache needed - real-time)
fastify.get('/api/admin/check-registration-status', async (request) => {
  const today = moment();
  const closeDate = moment(EVENT_DATES.registration_closes);
  
  if (today.isAfter(closeDate)) {
    // Close all events
    await pool.query(
      `UPDATE events SET is_active = false WHERE is_active = true`
    );
    
    // Clear events cache
    await invalidateEventsCache();
    
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

// 24. SCAN QR & MARK ATTENDANCE (Optimized)
fastify.post('/api/scan-attendance', async (request, reply) => {
  const client = await pool.connect();

  try {
    const { registration_id } = request.body;

    if (!registration_id) {
      return reply.code(400).send({ error: 'registration_id is required' });
    }

    // 1️⃣ Get registration, participant, and payment details
    const { rows } = await client.query(
      `SELECT 
          r.registration_unique_id,
          r.attendance_status,
          r.event_id,
          r.participant_id,

          p.full_name,
          p.email,
          p.college_name,
          p.department,

          py.verified_by_admin

       FROM registrations r
       JOIN participants p ON r.participant_id = p.participant_id
       LEFT JOIN payments py
         ON r.participant_id = py.participant_id
         AND py.created_at = (
           SELECT MAX(created_at)
           FROM payments
           WHERE participant_id = r.participant_id
         )
       WHERE r.registration_unique_id = $1`,
      [registration_id]
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Registration not found' });
    }

    const reg = rows[0];

    // 2️⃣ Check if payment is verified by admin
    if (!reg.verified_by_admin) {
      return reply.code(403).send({
        success: false,
        message: 'Participant payment not verified by admin. Attendance cannot be marked.',
        registration_id: reg.registration_unique_id,
        participant_id: reg.participant_id
      });
    }

    // 3️⃣ Check if attendance is already marked
    if (reg.attendance_status === 'ATTENDED') {
      return reply.send({
        success: true,
        message: 'Attendance already marked',
        registration_id: reg.registration_unique_id,
        participant_id: reg.participant_id
      });
    }

    // 4️⃣ Mark attendance
    const result = await client.query(
      `UPDATE registrations
       SET attendance_status = 'ATTENDED',
           attended_at = NOW()
       WHERE registration_unique_id = $1
       RETURNING registration_unique_id, attendance_status, event_id`,
      [registration_id]
    );

    // Clear cache
    await invalidateStatsCache();

    return reply.send({
      success: true,
      message: 'Attendance marked successfully',
      registration: result.rows[0],
      scanned_at: new Date().toISOString()
    });

  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Failed to mark attendance' });
  } finally {
    client.release();
  }
});



// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    await fastify.listen({
      port: PORT,
      host: '0.0.0.0'
    });

    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Connection pool ready: ${pool.totalCount} connections available`);
    console.log(`⚡ Rate limiting enabled: ${RATE_LIMIT.maxRequests} requests per ${RATE_LIMIT.windowMs/60000} minutes`);
    
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing server...');
  await fastify.close();
  await pool.end();
  console.log('Server closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Closing server...');
  await fastify.close();
  await pool.end();
  console.log('Server closed');
  process.exit(0);
});

start();
