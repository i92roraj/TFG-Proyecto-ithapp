// server.js
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();

// 1) Middleware
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*" })); // en producción, limita al dominio de tu app

// 2) Puerto (Railway establece PORT)
const port = process.env.PORT || 3000;

// 3) Pool MySQL (Railway inyecta estas variables al crear la DB)
const pool = mysql.createPool({
  host: process.env.MYSQLHOST || "localhost",
  port: process.env.MYSQLPORT ? Number(process.env.MYSQLPORT) : 3306,
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "",
  database: process.env.MYSQLDATABASE || "ganaderapp",
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------- Utilidades ----------
function normalizarDevEui(raw) {
  if (!raw) return null;
  return String(raw).toUpperCase().replace(/[^0-9A-F]/g, ""); // quita ":" y deja HEX
}

async function getOrCreateSensorByDevEui(devEui) {
  const [rows] = await pool.query(
    "SELECT id_sensor FROM sensores WHERE dev_eui = ?",
    [devEui]
  );
  if (rows.length) return rows[0].id_sensor;

  // Si no existe, creamos un sensor "placeholder"
  const [ins] = await pool.query(
    "INSERT INTO sensores (nombre_sensor, dev_eui, id_granja) VALUES (?, ?, ?)",
    [`TTN-${devEui}`, devEui, null]
  );
  return ins.insertId;
}

function lecturaValida(t, h, i) {
  if (typeof t !== "number" || t < -40 || t > 85) return false;
  if (typeof h !== "number" || h < 0 || h > 100) return false;
  if (typeof i !== "number" || i < 0 || i > 120) return false;
  return true;
}

// 4) Salud
app.get("/health", async (_req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "DB ping failed" });
  }
});

// 5) Endpoints

// --- Webhook TTN → inserta mediciones asociadas a un sensor por DevEUI ---
app.post("/webhook", async (req, res) => {
  try {
    const up = req.body?.uplink_message;
    const devEui = normalizarDevEui(req.body?.end_device_ids?.dev_eui);

    if (!up?.decoded_payload) {
      return res.status(400).json({ error: "Payload invalido" });
    }
    if (!devEui) {
      return res.status(400).json({ error: "Falta dev_eui en el webhook" });
    }

    const { temperatura, humedad, ith } = up.decoded_payload;
    if (!lecturaValida(temperatura, humedad, ith)) {
      return res.status(422).json({ error: "Lectura fuera de rango o no numérica" });
    }

    const idSensor = await getOrCreateSensorByDevEui(devEui);

    await pool.query(
      "INSERT INTO mediciones (id_sensor, temperatura, humedad, ith) VALUES (?, ?, ?, ?)",
      [idSensor, temperatura, humedad, ith]
    );

    console.log("✅ Medición guardada", { devEui, idSensor, temperatura, humedad, ith });
    res.send("OK");
  } catch (err) {
    console.error("❌ Error insertando mediciones:", err);
    res.status(500).send("Error en base de datos");
  }
});

// --- Altas de catálogo ---
app.post("/granjas", async (req, res) => {
  try {
    const { nombre_granja, direccion } = req.body;
    if (!nombre_granja || !direccion) {
      return res.status(400).send("Faltan datos de la granja");
    }
    const [result] = await pool.query(
      "INSERT INTO granjas (nombre_granja, direccion) VALUES (?, ?)",
      [nombre_granja, direccion]
    );
    res.status(201).json({ id_granja: result.insertId, mensaje: "Granja guardada" });
  } catch (err) {
    console.error("❌ Error insertando granja:", err);
    res.status(500).send("Error en base de datos");
  }
});

app.post("/usuarios", async (req, res) => {
  try {
    const { nombre, apellidos, email, fecha_nacimiento, password, id_granja } = req.body;
    if (!nombre || !email || !fecha_nacimiento || !password || !id_granja) {
      return res.status(400).send("Faltan datos del usuario");
    }
    const [result] = await pool.query(
      `INSERT INTO usuarios (nombre, apellidos, email, fecha_nacimiento, password, id_granja)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nombre, apellidos || "", email, fecha_nacimiento, password, id_granja]
    );
    res.status(201).json({ id_usuario: result.insertId, mensaje: "Usuario guardado" });
  } catch (err) {
    console.error("❌ Error insertando usuario:", err);
    res.status(500).send("Error en base de datos");
  }
});

app.post("/sensores", async (req, res) => {
  try {
    const { nombre_sensor, id_granja, dev_eui } = req.body || {};
    if (!nombre_sensor) {
      return res.status(400).send("Falta nombre_sensor");
    }
    // dev_eui es opcional, pero si viene lo normalizamos
    const devEui = normalizarDevEui(dev_eui);

    const [result] = await pool.query(
      "INSERT INTO sensores (nombre_sensor, id_granja, dev_eui) VALUES (?, ?, ?)",
      [nombre_sensor, id_granja ?? null, devEui ?? null]
    );

    res.status(201).json({ id_sensor: result.insertId, mensaje: "Sensor guardado" });
  } catch (err) {
    // Si dev_eui duplicado (UNIQUE), MySQL lanzará error
    console.error("❌ Error insertando sensor:", err);
    res.status(500).send("Error en base de datos");
  }
});

// --- Lecturas ---
// GET /mediciones -> última global o filtrada por dev_eui o id_sensor
app.get("/mediciones", async (req, res) => {
  try {
    const devEuiQ = normalizarDevEui(req.query.dev_eui);
    const idSensorQ = req.query.id_sensor ? Number(req.query.id_sensor) : null;

    if (devEuiQ) {
      const [rows] = await pool.query(
        `SELECT m.* FROM mediciones m
         JOIN sensores s ON s.id_sensor = m.id_sensor
         WHERE s.dev_eui = ?
         ORDER BY m.id DESC LIMIT 1`,
        [devEuiQ]
      );
      return rows.length ? res.json(rows[0]) : res.status(404).send("No hay datos");
    }

    if (idSensorQ) {
      const [rows] = await pool.query(
        "SELECT * FROM mediciones WHERE id_sensor = ? ORDER BY id DESC LIMIT 1",
        [idSensorQ]
      );
      return rows.length ? res.json(rows[0]) : res.status(404).send("No hay datos");
    }

    // Última medición general (comportamiento previo)
    const [rows] = await pool.query("SELECT * FROM mediciones ORDER BY id DESC LIMIT 1");
    return rows.length ? res.json(rows[0]) : res.status(404).send("No hay datos");
  } catch (err) {
    console.error("❌ Error al consultar mediciones:", err);
    res.status(500).send("Error en base de datos");
  }
});

// 6) Iniciar (sin ngrok)
app.listen(port, () => {
  console.log(`🚀 API escuchando en puerto ${port}`);
});
