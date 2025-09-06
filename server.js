const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();

// 1) Middleware
app.use(express.json());
app.use(cors({ origin: "*" })); // si usas Flutter Web, pon tu dominio en vez de '*'

// 2) Puerto (Railway coloca PORT)
const port = process.env.PORT || 3000;

// 3) Config MySQL (Railway inyecta estas vars al crear la DB)
const pool = mysql.createPool({
  host: process.env.MYSQLHOST || "localhost",
  port: process.env.MYSQLPORT ? Number(process.env.MYSQLPORT) : 3306,
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "",
  database: process.env.MYSQLDATABASE || "ganaderapp",
  waitForConnections: true,
  connectionLimit: 10,
});

let lastDevEui = null;


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

// TTN webhook → inserta mediciones y cachea el DEV_EUI
app.post("/webhook", async (req, res) => {
  try {
    // 🟣 cachear dev_eui en memoria (no persiste si reinicias el server)
    const devEui = req.body?.end_device_ids?.dev_eui
                || req.body?.end_device_ids?.device_id
                || null;
    if (devEui) lastDevEui = devEui;

    const uplink = req.body.uplink_message;
    if (!uplink?.decoded_payload) {
      return res.status(400).send("Payload invalido");
    }

    const { temperatura, humedad, ith } = uplink.decoded_payload;
    await pool.query(
      "INSERT INTO mediciones (temperatura, humedad, ith) VALUES (?, ?, ?)",
      [temperatura, humedad, ith]
    );

    console.log("✅ Datos recibidos:", { temperatura, humedad, ith, devEui });
    res.send("OK");
  } catch (err) {
    console.error("❌ Error insertando mediciones:", err);
    res.status(500).send("Error en base de datos");
  }
});

// Endpoint simple para la app
app.get("/dev-eui-ultimo", (_req, res) => {
  if (!lastDevEui) return res.status(404).json({ error: "sin_dev_eui" });
  res.json({ dev_eui: lastDevEui });
});

// Granja
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

// Usuario
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

// Sensor
app.post("/sensores", async (req, res) => {
  try {
    const { nombre_sensor, id_granja } = req.body;
    if (!nombre_sensor || !id_granja) {
      return res.status(400).send("Faltan datos del sensor");
    }

    const [result] = await pool.query(
      "INSERT INTO sensores (nombre_sensor, id_granja) VALUES (?, ?)",
      [nombre_sensor, id_granja]
    );

    res.status(201).json({ id_sensor: result.insertId, mensaje: "Sensor guardado" });
  } catch (err) {
    console.error("❌ Error insertando sensor:", err);
    res.status(500).send("Error en base de datos");
  }
});

// Última medición
app.get("/mediciones", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM mediciones ORDER BY id DESC LIMIT 1");
    if (rows.length > 0) return res.json(rows[0]);
    res.status(404).send("No hay datos disponibles");
  } catch (err) {
    console.error("❌ Error al consultar mediciones:", err);
    res.status(500).send("Error en base de datos");
  }
});

// PUT /api/sensores/actualizar
app.put('/api/sensores/actualizar', async (req, res) => {
  const {
    id_sensor,          // opcional pero recomendado
    dev_eui,            // opcional; si existe actualiza por EUI
    modelo, area, zona, sala,
    modo,               // 'auto' | 'manual'
    umbral_ith,         // int o null
    dev_id              // opcional (TTN device_id)
  } = req.body;

  if (!id_sensor && !dev_eui) {
    return res.status(400).json({ error: 'falta_id_o_dev_eui' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Construye el WHERE dinámico
    let where = '';
    let whereParam;
    if (id_sensor) { where = 'id_sensor = ?'; whereParam = id_sensor; }
    else           { where = 'dev_eui   = ?'; whereParam = dev_eui;  }

    // Actualiza campos (COALESCE = sólo pisa si viene valor)
    const [r1] = await conn.query(
      `UPDATE sensores
         SET modelo     = COALESCE(?, modelo),
             area       = COALESCE(?, area),
             zona       = COALESCE(?, zona),
             sala       = COALESCE(?, sala),
             modo       = COALESCE(?, modo),
             umbral_ith = ?,
             dev_id     = COALESCE(?, dev_id),
             updated_at = NOW()
       WHERE ${where}`,
      [modelo ?? null, area ?? null, zona ?? null, sala ?? null,
       modo ?? null, (umbral_ith ?? null), dev_id ?? null, whereParam]
    );

    // Si envías id_sensor y dev_eui, vincula el dev_eui si aún no estaba
    if (id_sensor && dev_eui) {
      await conn.query(
        `UPDATE sensores
           SET dev_eui = ?
         WHERE id_sensor = ?
           AND (dev_eui IS NULL OR dev_eui = '')`,
        [dev_eui, id_sensor]
      );
    }

    await conn.commit();
    res.json({ ok: true, affected: r1.affectedRows });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'dev_eui_duplicado' });
    }
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    conn.release();
  }
});


// 6) Iniciar (sin ngrok)
app.listen(port, () => {
  console.log(`🚀 API escuchando en puerto ${port}`);
});
