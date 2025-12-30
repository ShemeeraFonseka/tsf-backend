const express = require('express')
const cors = require('cors')
require('dotenv').config()
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())


const productlistRouter = require('./routes/productlist')
app.use('/api/productlist', productlistRouter)

const customerlistRouter = require('./routes/customerlist')
app.use('/api/customerlist', customerlistRouter)

app.use('/api/customer-products', require('./routes/customerProducts'))



const exportproductlistRouter = require('./routes/exportproductlist')
app.use('/api/exportproductlist', exportproductlistRouter)

const exportcustomerlistRouter = require('./routes/exportcustomerlist')
app.use('/api/exportcustomerlist', exportcustomerlistRouter)

app.use('/api/exportcustomer-products', require('./routes/exportcustomerProducts'))


// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))


const port = process.env.PORT
app.listen(port, () => console.log(`API listening on port ${port}`))