//app.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Session setup
app.use(session({
	store: new PgSession({
		pool: new Pool({ connectionString: process.env.DATABASE_URL }),
		tableName: 'sessions'
	}),
	secret: process.env.SESSION_SECRET || 'marlette-precinct-2026',
	resave: false,
	saveUninitialized: false,
	cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// PostgreSQL Pool
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: { rejectUnauthorized: false }
});

// Routes
app.get('/', (req, res) => res.render('index'));
app.get('/meet-the-team', (req, res) => res.render('meet-the-team'));
app.get('/contact', (req, res) => {
	res.render('contact', { 
		submitted: req.query.submitted === 'true',
		error: req.query.error === 'true'
	});
});

// CONTACT / VOLUNTEER FORM
app.post('/contact', async (req, res) => {
	const { firstName, lastName, email, phone, message, volunteerOptions } = req.body;

	try {
		await pool.query(`
			INSERT INTO submissions 
			(type, first_name, last_name, email, phone, message, volunteer_options)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, [
			volunteerOptions && volunteerOptions.length > 0 ? 'volunteer' : 'contact',
			firstName,
			lastName,
			email,
			phone || null,
			message || null,
			Array.isArray(volunteerOptions) ? volunteerOptions : []
		]);

		// Send email notification
		const transporter = nodemailer.createTransport({
			service: 'gmail',
			auth: {
				user: process.env.EMAIL_USER,
				pass: process.env.EMAIL_PASS
			}
		});

		await transporter.sendMail({
			from: `"Marlette Precinct" <${process.env.EMAIL_USER}>`,
			to: process.env.EMAIL_USER,
			replyTo: email,
			subject: `New ${volunteerOptions && volunteerOptions.length ? 'Volunteer' : 'Contact'} Form Submission`,
			html: `
				<h2>New Submission</h2>
				<p><strong>Name:</strong> ${firstName} ${lastName}</p>
				<p><strong>Email:</strong> ${email}</p>
				${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ''}
				${message ? `<p><strong>Message:</strong><br>${message.replace(/\n/g, '<br>')}</p>` : ''}
				${volunteerOptions && volunteerOptions.length ? `<p><strong>Volunteer Interests:</strong> ${volunteerOptions.join(', ')}</p>` : ''}
			`
		});

		res.redirect('/contact?submitted=true');
	} catch (err) {
    	console.error('Submission error:', err);
		res.redirect('/contact?error=true');
	}
});

// ADMIN ROUTES
app.get('/admin', (req, res) => {
	if (req.session.admin) {
		res.redirect('/admin/dashboard');
	} else {
		res.redirect('/admin/login');
	}
});

app.get('/admin/login', (req, res) => {
	res.render('admin-login', { error: false });
});

app.post('/admin/login', async (req, res) => {
	const { username, password } = req.body;
	
	// Simple hardcoded admin for now (we'll improve later)
	if (username === 'admin' && password === 'marlette2026') {
		req.session.admin = true;
		res.redirect('/admin/dashboard');
	} else {
		res.render('admin-login', { error: true });
	}
});

app.get('/admin/dashboard', async (req, res) => {
	if (!req.session.admin) return res.redirect('/admin/login');

	try {
		const result = await pool.query(`
			SELECT * FROM submissions 
			WHERE deleted_at IS NULL 
			ORDER BY created_at DESC
		`);
		
		res.send(`
			<h1>Admin Dashboard</h1>
			<p><a href="/admin/logout">Logout</a></p>
			<pre>${JSON.stringify(result.rows, null, 2)}</pre>
		`);
	} catch (e) {
		res.send('Database error');
	}
});

app.get('/admin/logout', (req, res) => {
	req.session.destroy();
	res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
