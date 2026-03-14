import bcrypt from "bcrypt";
import express from "express";
import supabase from "../db.js";

const router = express.Router();

// REGISTER
router.post("/register", async (req, res) => {
  const { name, email, password, position } = req.body;

  const hashedPassword = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from("users")
    .insert([{ name, email, password: hashedPassword, position }]);

  if (error) return res.status(400).json(error);

  res.json({ message: "User created successfully" });
});

// LOGIN
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .single();

  if (!data) return res.status(404).json({ message: "User not found" });

  const validPassword = await bcrypt.compare(password, data.password);

  if (!validPassword)
    return res.status(401).json({ message: "Invalid password" });

  res.json({ message: "Login success", user: data });
});

export default router;
