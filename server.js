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

app.get('/api/dev-eui-ultimo', async (_req, res) => {
  const q1 = `
    SELECT dev_eui
    FROM sensores
    WHERE dev_eui IS NOT NULL AND dev_eui <> ''
    ORDER BY updated_at DESC, id_sensor DESC
    LIMIT 1`;
  const q2 = `
    SELECT dev_eui
    FROM sensores
    WHERE dev_eui IS NOT NULL AND dev_eui <> ''
    ORDER BY id_sensor DESC
    LIMIT 1`;
  try {
    const [rows] = await pool.query(q1);
    if (!rows.length) return res.status(404).json({ error: 'sin_dev_eui' });
    res.json({ dev_eui: rows[0].dev_eui });
  } catch (e) {
    // Si 'updated_at' no existe, probamos sin ella
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      const [rows] = await pool.query(q2);
      if (!rows.length) return res.status(404).json({ error: 'sin_dev_eui' });
      return res.json({ dev_eui: rows[0].dev_eui });
    }
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
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

// POST /api/ttn/downlink  { dev_eui, cmd }
app.post('/api/downlink', async (req, res) => {
  try {
    let { dev_eui, cmd } = req.body || {};
    if (!dev_eui || !cmd) return res.status(400).json({ error: 'faltan_campos' });

    dev_eui = String(dev_eui).trim().toUpperCase();

    // 1) Buscar app_id y device_id por dev_eui
    const [rows] = await pool.query(
      `SELECT app_id, device_id
         FROM sensores
        WHERE UPPER(TRIM(dev_eui)) = ?
        LIMIT 1`,
      [dev_eui]
    );
    if (!rows.length) return res.status(404).json({ error: 'sensor_no_encontrado' });

    const { app_id, device_id } = rows[0];
    if (!app_id || !device_id) {
      return res.status(409).json({ error: 'falta_app_o_device_id' });
    }

    // 2) Preparar petición a TTN v3 (región EU1)
    const TTN_API_KEY = process.env.TTN_API_KEY; // NNSXS_...
    if (!TTN_API_KEY) return res.status(500).json({ error: 'ttn_api_key_no_configurada' });

    const url = `https://eu1.cloud.thethings.network/api/v3/as/applications/${app_id}/devices/${device_id}/down/push`;

    // El nodo espera ASCII, TTN exige base64 en frm_payload
    const frmPayloadB64 = Buffer.from(String(cmd), 'utf8').toString('base64');

    const body = {
      downlinks: [
        {
          f_port: 1,                 // tu nodo usa port 1 (modem.setPort(1))
          frm_payload: frmPayloadB64,
          priority: 'NORMAL'
        }
      ]
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TTN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    if (!r.ok) {
      console.error('TTN downlink error', r.status, text);
      return res.status(502).json({ error: 'ttn_error', status: r.status, detail: text });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'downlink_error' });
  }
});



// PUT /api/sensores/actualizar
app.put('/api/sensores/actualizar', async (req, res) => {
  try {
    let { dev_eui, modelo, area, zona, sala, modo, umbral_ith } = req.body;
    if (!dev_eui) return res.status(400).json({error:'dev_eui_requerido'});
    dev_eui = String(dev_eui).trim().toUpperCase();

    // localiza por dev_eui (normalizando)
    const [rows] = await pool.query(
      `SELECT id_sensor, UPPER(TRIM(dev_eui)) AS eui FROM sensores WHERE dev_eui IS NOT NULL`
    );
    const row = rows.find(r => r.eui === dev_eui);
    if (!row) return res.status(404).json({error:'sensor_no_encontrado'});

    // actualiza solo lo que venga con valor
    await pool.query(
      `UPDATE sensores SET
          modelo     = COALESCE(NULLIF(?, ''), modelo),
          area       = COALESCE(NULLIF(?, ''), area),
          zona       = COALESCE(?, zona),
          sala       = COALESCE(NULLIF(?, ''), sala),
          modo       = COALESCE(NULLIF(?, ''), modo),
          umbral_ith = COALESCE(?, umbral_ith),
          updated_at = NOW()
        WHERE id_sensor = ?`,
      [modelo, area, zona, sala, modo, umbral_ith, row.id_sensor]
    );

    res.json({ ok:true });
  } catch (e) {
    console.error(e); res.status(500).json({error:'db_error'});
  }
});


// 6) Iniciar (sin ngrok)
app.listen(port, () => {
  console.log(`🚀 API escuchando en puerto ${port}`);
});
