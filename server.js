import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import pg from 'pg';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';

dotenv.config();
const { Pool } = pg;

// -------------------- PostgreSQL Setup --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const redis = new Redis({
  url: 'https://delicate-mosquito-32342.upstash.io',
  token: 'AX5WAAIncDI5ODNkYzBkOTlhZmQ0NzU5YmIxNThlYWUxM2E0ZTUyN3AyMzIzNDI',
});

// Helper function to push job to queue
const pushToQueue = async (queueName, data) => {
  await redis.lpush(queueName, JSON.stringify(data));
};

// -------------------- Fastify Setup --------------------
const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: '*' });
await fastify.register(formbody);

// -------------------- ROUTES --------------------

// 1️⃣ Participant Registration + Event Selection
fastify.post('/register', async (request, reply) => {
  const {
    full_name,
    email,
    phone,
    college_name,
    department,
    year_of_study,
    city,
    state,
    accommodation_required,
    event_ids,
  } = request.body;

  if (!event_ids || !Array.isArray(event_ids) || event_ids.length === 0) {
    return reply.status(400).send({ success: false, error: "No events selected" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const participantRes = await client.query(
      `INSERT INTO participants(full_name,email,phone,college_name,department,year_of_study,city,state,accommodation_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING participant_id`,
      [full_name,email,phone,college_name,department,year_of_study,city,state,accommodation_required]
    );
    const participant_id = participantRes.rows[0].participant_id;

    const registrationIds = [];
    const isCSE = email.toLowerCase().includes('cse');

    for (let event_id of event_ids) {
      const existing = await client.query(
        `SELECT 1 FROM registrations WHERE participant_id=$1 AND event_id=$2`,
        [participant_id, event_id]
      );
      if (existing.rows.length > 0) continue;

      const eventRes = await client.query(
        `SELECT event_type, day, available_seats, cse_available_seats FROM events WHERE event_id=$1`,
        [event_id]
      );
      if (eventRes.rows.length === 0) continue;

      let { event_type, day, available_seats, cse_available_seats } = eventRes.rows[0];
      let seatAllocated = false;

      if (isCSE && cse_available_seats > 0) {
        await client.query(
          `UPDATE events 
           SET cse_available_seats = cse_available_seats - 1,
               available_seats = available_seats - 1
           WHERE event_id = $1`,
          [event_id]
        );
        seatAllocated = true;
      } else if (available_seats > 0) {
        await client.query(
          `UPDATE events SET available_seats = available_seats - 1 WHERE event_id=$1`,
          [event_id]
        );
        seatAllocated = true;
      }

      if (!seatAllocated) continue;

      const regRes = await client.query(
        `INSERT INTO registrations(participant_id, event_id, registration_unique_id)
         VALUES($1, $2, 'TEMP') RETURNING registration_id`,
        [participant_id, event_id]
      );

      const registration_id_num = regRes.rows[0].registration_id;
      const prefix = (day === 'Day1' && event_type === 'Workshop') ? 'THREADS26WORKSHOP' : 'THREADS26EVENT';
      const registration_unique_id = `${prefix}${registration_id_num.toString().padStart(4, '0')}`;

      await client.query(
        `UPDATE registrations SET registration_unique_id=$1 WHERE registration_id=$2`,
        [registration_unique_id, registration_id_num]
      );

      registrationIds.push(registration_unique_id);

      // ✅ Push registration info to Redis queue for async processing
      await pushToQueue('registrationQueue', {
        participant_id,
        registration_unique_id,
        event_id,
        timestamp: new Date().toISOString(),
      });
    }

    await client.query('COMMIT');

    if (registrationIds.length === 0) {
      return reply.send({ success: false, message: "No seats available or already registered" });
    }

    reply.send({ success: true, participant_id, registration_ids: registrationIds });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    reply.status(500).send({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 2️⃣ One-Time Payment for Multiple Events
fastify.post('/payment', async (request, reply) => {
  const { participant_id, payment_method, amount, registration_ids } = request.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const paymentRes = await client.query(
      `INSERT INTO payments(participant_id,payment_method,amount,payment_status)
       VALUES($1,$2,$3,'Success') RETURNING *`,
      [participant_id, payment_method, amount]
    );

    await client.query(
      `UPDATE registrations
       SET payment_status='Success', amount_paid=$1
       WHERE registration_unique_id = ANY($2::text[])`,
      [amount, registration_ids]
    );

    // ✅ Push payment info to Redis queue
    await pushToQueue('paymentQueue', {
      participant_id,
      registration_ids,
      amount,
      payment_method,
      timestamp: new Date().toISOString(),
    });

    await client.query('COMMIT');
    reply.send({ success: true, payment: paymentRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    reply.status(500).send({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// -------------------- Other Routes (Gallery / Events) --------------------
fastify.post('/gallery', async (request, reply) => {
  const { album_name, image_url } = request.body;

  try {
    const res = await pool.query(
      `INSERT INTO gallery(album_name,image_url) VALUES($1,$2) RETURNING *`,
      [album_name, image_url]
    );
    reply.send({ success: true, image: res.rows[0] });
  } catch (err) {
    console.error(err);
    reply.status(500).send({ success: false, error: err.message });
  }
});

fastify.get('/events', async (request, reply) => {
  try {
    const res = await pool.query(`
      SELECT * FROM events
      WHERE is_active IS DISTINCT FROM FALSE
      ORDER BY day, event_type
    `);
    reply.send({ success: true, events: res.rows });
  } catch (err) {
    console.error(err);
    reply.status(500).send({ success: false, error: err.message });
  }
});

// -------------------- START SERVER --------------------
const start = async () => {
  try {
    const port = process.env.PORT || 3000;

    await fastify.listen({
      port,
      host: '0.0.0.0', // 🔥 REQUIRED for Render
    });

    console.log(`Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

