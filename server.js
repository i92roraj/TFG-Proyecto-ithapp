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

// TTN webhook → inserta mediciones
app.post("/webhook", async (req, res) => {
  try {
    const uplink = req.body.uplink_message;
    if (!uplink?.decoded_payload) {
      return res.status(400).send("Payload invalido");
    }

    const { temperatura, humedad, ith } = uplink.decoded_payload;
    const sql = "INSERT INTO mediciones (temperatura, humedad, ith) VALUES (?, ?, ?)";
    await pool.query(sql, [temperatura, humedad, ith]);

    console.log("✅ Datos recibidos:", { temperatura, humedad, ith });
    res.send("OK");
  } catch (err) {
    console.error("❌ Error insertando mediciones:", err);
    res.status(500).send("Error en base de datos");
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

// 6) Iniciar (sin ngrok)
app.listen(port, () => {
  console.log(`🚀 API escuchando en puerto ${port}`);
});
