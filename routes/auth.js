import bcrypt from "bcrypt";
import express from "express";
import crypto from "crypto";
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

// FORGOT PASSWORD
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .single();

  if (!user)
    return res
      .status(404)
      .json({ message: "No account found with that email" });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from("password_reset_tokens")
    .upsert([{ email, token, expires_at: expiresAt }], { onConflict: "email" });

  if (error)
    return res.status(500).json({ message: "Failed to generate reset token" });

  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

  console.log(`[Reset Link] ${resetLink}`);

  // Return resetLink — EmailJS sends the email from frontend
  res.json({ message: "Token generated", resetLink });
});

// RESET PASSWORD
router.post("/reset-password", async (req, res) => {
  const { email, token, newPassword } = req.body;

  if (!email || !token || !newPassword)
    return res.status(400).json({ message: "All fields are required" });

  const { data: resetRecord } = await supabase
    .from("password_reset_tokens")
    .select("*")
    .eq("email", email)
    .eq("token", token)
    .single();

  if (!resetRecord)
    return res.status(400).json({ message: "Invalid or expired reset link" });

  if (new Date() > new Date(resetRecord.expires_at))
    return res.status(400).json({ message: "Reset link has expired" });

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  const { error: updateError } = await supabase
    .from("users")
    .update({ password: hashedPassword })
    .eq("email", email);

  if (updateError)
    return res.status(500).json({ message: "Failed to update password" });

  await supabase.from("password_reset_tokens").delete().eq("email", email);

  res.json({ message: "Password reset successfully" });
});

export default router;
