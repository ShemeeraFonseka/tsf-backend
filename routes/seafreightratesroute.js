import express from 'express'
import supabase from '../db.js'

const router = express.Router()

// GET all sea freight rates (sorted by most recent)
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100

        const { data: rates, error } = await supabase
            .from('sea_freight_rates')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(limit)

        if (error) throw error

        console.log('Fetched sea freight rates sample:', rates?.[0]) // Debug log
        res.json(rates)
    } catch (err) {
        console.error('Error fetching sea freight rates:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})

// GET sea freight rates for a specific country
router.get('/country/:country', async (req, res) => {
    try {
        const { country } = req.params

        const { data: rates, error } = await supabase
            .from('sea_freight_rates')
            .select('*')
            .eq('country', country)
            .order('updated_at', { ascending: false })

        if (error) throw error

        res.json(rates)
    } catch (err) {
        console.error('Error fetching sea freight rates by country:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})

// GET latest rate for a specific country and port
router.get('/country/:country/port/:port_code/latest', async (req, res) => {
    try {
        const { country, port_code } = req.params

        const { data: rate, error } = await supabase
            .from('sea_freight_rates')
            .select('*')
            .eq('country', country)
            .eq('port_code', port_code.toUpperCase())
            .order('updated_at', { ascending: false })
            .limit(1)
            .single()

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ message: 'No rate found for this country and port' })
            }
            throw error
        }

        res.json(rate)
    } catch (err) {
        console.error('Error fetching latest rate by country and port:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})

// GET latest rate for a specific country (any port)
router.get('/country/:country/latest', async (req, res) => {
    try {
        const { country } = req.params

        const { data: rate, error } = await supabase
            .from('sea_freight_rates')
            .select('*')
            .eq('country', country)
            .order('updated_at', { ascending: false })
            .limit(1)
            .single()

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ message: 'No rate found for this country' })
            }
            throw error
        }

        res.json(rate)
    } catch (err) {
        console.error('Error fetching latest rate by country:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})


// POST - Create new sea freight rate
router.post('/', async (req, res) => {
    try {
        const {
            country,
            port_code,
            port_name,
            rate_20ft,
            kilos_20ft,
            freight_per_kilo_20ft,
            rate_40ft,
            kilos_40ft,
            freight_per_kilo_40ft,
            date
        } = req.body

        // DEBUG: Log incoming data
        console.log('=== POST Request Data ===')
        console.log('Country:', country)
        console.log('Port Code:', port_code)
        console.log('Port Name:', port_name)
        console.log('Rates 20ft:', { rate_20ft, kilos_20ft, freight_per_kilo_20ft })
        console.log('Rates 40ft:', { rate_40ft, kilos_40ft, freight_per_kilo_40ft })
        console.log('Date:', date)
        console.log('========================')

        if (!country || !port_code || !port_name ||
            !rate_20ft || !kilos_20ft ||
            !rate_40ft || !kilos_40ft) {
            return res.status(400).json({
                message: 'Country, port code, port name, and all container rates are required'
            })
        }

        // Validate all rates and kilos are positive
        if (parseFloat(rate_20ft) <= 0 || parseFloat(rate_40ft) <= 0 ||
            parseFloat(kilos_20ft) <= 0 || parseFloat(kilos_40ft) <= 0) {
            return res.status(400).json({ message: 'All rates and kilos must be greater than 0' })
        }

        const insertData = {
            country: country.trim(),
            port_code: port_code.trim().toUpperCase(),
            port_name: port_name.trim(),
            rate_20ft: parseFloat(rate_20ft),
            kilos_20ft: parseFloat(kilos_20ft),
            freight_per_kilo_20ft: parseFloat(freight_per_kilo_20ft),
            rate_40ft: parseFloat(rate_40ft),
            kilos_40ft: parseFloat(kilos_40ft),
            freight_per_kilo_40ft: parseFloat(freight_per_kilo_40ft),
            date: date || new Date().toISOString(),
            updated_at: new Date().toISOString()
        }

        // DEBUG: Log data being inserted
        console.log('Inserting data:', insertData)

        const { data: newRate, error } = await supabase
            .from('sea_freight_rates')
            .insert(insertData)
            .select()
            .single()

        if (error) {
            console.error('Supabase insert error:', error)
            throw error
        }

        // DEBUG: Log returned data
        console.log('Inserted record:', newRate)

        res.status(201).json({
            message: 'Sea freight rate added successfully',
            data: newRate
        })
    } catch (err) {
        console.error('Error adding sea freight rate:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})


// PUT - Update existing sea freight rate
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params
        const {
            country,
            port_code,
            port_name,
            rate_20ft,
            kilos_20ft,
            freight_per_kilo_20ft,
            rate_40ft,
            kilos_40ft,
            freight_per_kilo_40ft,
            date
        } = req.body

        // DEBUG: Log incoming data
        console.log('=== PUT Request Data ===')
        console.log('ID:', id)
        console.log('Country:', country)
        console.log('Port Code:', port_code)
        console.log('Port Name:', port_name)
        console.log('========================')

        if (!country || !port_code || !port_name ||
            !rate_20ft || !kilos_20ft ||
            !rate_40ft || !kilos_40ft) {
            return res.status(400).json({
                message: 'Country, port code, port name, and all container rates are required'
            })
        }

        // Validate all rates and kilos are positive
        if (parseFloat(rate_20ft) <= 0 || parseFloat(rate_40ft) <= 0 ||
            parseFloat(kilos_20ft) <= 0 || parseFloat(kilos_40ft) <= 0) {
            return res.status(400).json({ message: 'All rates and kilos must be greater than 0' })
        }

        const updateData = {
            country: country.trim(),
            port_code: port_code.trim().toUpperCase(),
            port_name: port_name.trim(),
            rate_20ft: parseFloat(rate_20ft),
            kilos_20ft: parseFloat(kilos_20ft),
            freight_per_kilo_20ft: parseFloat(freight_per_kilo_20ft),
            rate_40ft: parseFloat(rate_40ft),
            kilos_40ft: parseFloat(kilos_40ft),
            freight_per_kilo_40ft: parseFloat(freight_per_kilo_40ft),
            date: date || new Date().toISOString(),
            updated_at: new Date().toISOString()
        }

        // DEBUG: Log data being updated
        console.log('Updating with data:', updateData)

        const { data: updatedRate, error } = await supabase
            .from('sea_freight_rates')
            .update(updateData)
            .eq('id', id)
            .select()
            .single()

        if (error) {
            console.error('Supabase update error:', error)
            throw error
        }

        // DEBUG: Log returned data
        console.log('Updated record:', updatedRate)

        res.json({
            message: 'Sea freight rate updated successfully',
            data: updatedRate
        })
    } catch (err) {
        console.error('Error updating sea freight rate:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})


// DELETE - Remove sea freight rate
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params

        const { error } = await supabase
            .from('sea_freight_rates')
            .delete()
            .eq('id', id)

        if (error) throw error

        res.json({ message: 'Sea freight rate deleted successfully' })
    } catch (err) {
        console.error('Error deleting sea freight rate:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})

// GET rate for specific date, country, and port
router.get('/date/:date/country/:country/port/:port_code', async (req, res) => {
    try {
        const { date, country, port_code } = req.params
        const searchDate = new Date(date)

        // Get start and end of day
        const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString()
        const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999)).toISOString()

        const { data: rate, error } = await supabase
            .from('sea_freight_rates')
            .select('*')
            .eq('country', country)
            .eq('port_code', port_code.toUpperCase())
            .gte('date', startOfDay)
            .lte('date', endOfDay)
            .order('updated_at', { ascending: false })
            .limit(1)
            .single()

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ message: 'No rate found for this date, country, and port' })
            }
            throw error
        }

        res.json(rate)
    } catch (err) {
        console.error('Error fetching rate by date, country, and port:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})

// GET rate for specific date and country (legacy - any port)
router.get('/date/:date/country/:country', async (req, res) => {
    try {
        const { date, country } = req.params
        const searchDate = new Date(date)

        // Get start and end of day
        const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString()
        const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999)).toISOString()

        const { data: rate, error } = await supabase
            .from('sea_freight_rates')
            .select('*')
            .eq('country', country)
            .gte('date', startOfDay)
            .lte('date', endOfDay)
            .order('updated_at', { ascending: false })
            .limit(1)
            .single()

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ message: 'No rate found for this date and country' })
            }
            throw error
        }

        res.json(rate)
    } catch (err) {
        console.error('Error fetching rate by date and country:', err)
        res.status(500).json({ message: 'Server error', error: err.message })
    }
})

export default router