import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

// Import routes
import productlistRouter from './routes/productlist.js'
app.use('/api/productlist', productlistRouter)

import customerlistRouter from './routes/customerlist.js'
app.use('/api/customerlist', customerlistRouter)

import customerProductsRouter from './routes/customerProducts.js'
app.use('/api/customer-products', customerProductsRouter)

import exportproductlistRouter from './routes/exportproductlist.js'
app.use('/api/exportproductlist', exportproductlistRouter)

import exportcustomerlistRouter from './routes/exportcustomerlist.js'
app.use('/api/exportcustomerlist', exportcustomerlistRouter)

import exportcustomerProductsRouter from './routes/exportcustomerProducts.js'
app.use('/api/exportcustomer-products', exportcustomerProductsRouter)

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

const port = process.env.PORT
app.listen(port, () => console.log(`API listening on port ${port}`))