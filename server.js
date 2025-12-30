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

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'Tropical Shellfish API',
    status: 'Running',
    endpoints: {
      productlist: '/api/productlist',
      customerlist: '/api/customerlist',
      customerProducts: '/api/customer-products',
      exportproductlist: '/api/exportproductlist',
      exportcustomerlist: '/api/exportcustomerlist',
      exportcustomerProducts: '/api/exportcustomer-products'
    }
  })
})

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

// For local development
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 5000
  app.listen(port, () => console.log(`API listening on port ${port}`))
}

// Export for Vercel
export default app