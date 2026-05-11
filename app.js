//app.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const app = express();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Session setup
app.use(session({
	store: new PgSession({
  		pool: new Pool({ 
			connectionString: process.env.DATABASE_URL,
			ssl: false 
		}),
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
	ssl: false
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
	try {
		// Try email or name
		const result = await pool.query(
			'SELECT * FROM admins WHERE (email = $1 OR name = $1) AND active = true',
			[username]
		);
		if (result.rows.length === 0) {
			return res.render('admin-login', { error: true });
		}

		const admin = result.rows[0];
		const match = await bcrypt.compare(password, admin.password_hash);
		if (match) {
			req.session.admin = true;
			req.session.adminEmail = admin.email;
			req.session.adminName = admin.name;
			return res.redirect('/admin/dashboard');
		} else {
			return res.render('admin-login', { error: true });
		}
	} catch (e) {
		console.error(e);
		res.render('admin-login', { error: true });
	}
});

// Dashboard with Show Deleted support
app.get('/admin/dashboard', async (req, res) => {
	if (!req.session.admin) return res.redirect('/admin/login');
	const showDeleted = req.query.showDeleted === 'true';
	try {
		const result = await pool.query(`
			SELECT * FROM submissions 
			WHERE deleted_at IS ${showDeleted ? 'NOT' : ''} NULL 
			ORDER BY created_at DESC
		`);
		res.render('admin-dashboard', { 
			submissions: result.rows,
			showDeleted: showDeleted
		});
	} catch (e) {
		console.error(e);
		res.send('Database error');
	}
});

// Toggle Highlight
app.post('/admin/highlight', async (req, res) => {
	if (!req.session.admin) return res.status(401).send('Unauthorized');
	const { id, highlighted } = req.body;
	await pool.query('UPDATE submissions SET highlighted = $1 WHERE id = $2', [highlighted, id]);
	res.sendStatus(200);
});

// Export to CSV
app.get('/admin/export-csv', async (req, res) => {
	if (!req.session.admin) return res.redirect('/admin/login');
	try {
		const result = await pool.query('SELECT * FROM submissions ORDER BY created_at DESC');
		let csv = 'Date,Name,Type,Email,Phone,Message,Volunteer Options,Highlighted,Deleted\n';
		result.rows.forEach(row => {
			csv += `"${row.created_at}","${row.first_name} ${row.last_name}","${row.type}","${row.email}","${row.phone || ''}","${(row.message || '').replace(/"/g, '""')}","${(row.volunteer_options || []).join('; ')}",${row.highlighted},${row.deleted_at ? 'Yes' : 'No'}\n`;
		});
		res.header('Content-Type', 'text/csv');
		res.attachment('marlette-submissions.csv');
		res.send(csv);
	} catch (e) {
		res.send('Export failed');
	}
});

app.post('/admin/delete', async (req, res) => {
	if (!req.session.admin) return res.redirect('/admin/login');
	const { id } = req.body;
	try {
		await pool.query(`
			UPDATE submissions 
			SET deleted_at = CURRENT_TIMESTAMP, 
				deleted_by = 'admin'
			WHERE id = $1
		`, [id]);
		res.redirect('/admin/dashboard');
	} catch (e) {
		console.error(e);
		res.send('Delete failed');
	}
});

app.get('/admin/logout', (req, res) => {
	req.session.destroy();
	res.redirect('/');
});

// ====================== INVITE SYSTEM ======================

// Invite Page
app.get('/admin/invite', (req, res) => {
	if (!req.session.admin) return res.redirect('/admin/login');
	res.render('admin-invite', { success: false, error: false });
});

app.post('/admin/invite', async (req, res) => {
	if (!req.session.admin) return res.redirect('/admin/login');
	const { email, name } = req.body;
	try {
		const token = crypto.randomBytes(32).toString('hex');
		const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

		await pool.query(`
			INSERT INTO invite_tokens (email, token, expires_at, invited_by)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (email) DO UPDATE 
			SET token = $2, expires_at = $3, invited_by = $4
		`, [email, token, expiresAt, 'admin']);

		const inviteLink = `https://${req.get('host')}/admin/signup?token=${token}&email=${encodeURIComponent(email)}`;

		// Send invite email
		const transporter = nodemailer.createTransport({
			service: 'gmail',
			auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
		});

		await transporter.sendMail({
			from: `"Marlette Precinct Admin" <${process.env.EMAIL_USER}>`,
			to: email,
			subject: "You've been invited to Marlette Precinct Admin Panel",
			html: `
				<h2>Welcome to the Team!</h2>
				<p>You've been invited to manage Marlette Precinct submissions.</p>
				<p><a href="${inviteLink}" style="background:#1D3557;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;">Set Your Password & Login</a></p>
				<p><small>This link expires in 48 hours.</small></p>
			`
		});
		res.render('admin-invite', { success: true, error: false });
	} catch (e) {
		console.error(e);
		res.render('admin-invite', { success: false, error: true });
	}
});

// Signup Page (from invite link)
app.get('/admin/signup', async (req, res) => {
	const { token, email } = req.query;
	try {
		const result = await pool.query(
			'SELECT * FROM invite_tokens WHERE email = $1 AND token = $2 AND expires_at > NOW()',
			[email, token]
		);
		if (result.rows.length === 0) {
			return res.send('This invite link is invalid or has expired.');
		}
		res.render('admin-signup', { email, token, error: false });
	} catch (e) {
		res.send('Error processing invite');
	}
});

app.post('/admin/signup', async (req, res) => {
	const { email, token, password, name } = req.body;
	try {
		// Verify token
		const tokenCheck = await pool.query(
			'SELECT * FROM invite_tokens WHERE email = $1 AND token = $2 AND expires_at > NOW()',
			[email, token]
		);
		if (tokenCheck.rows.length === 0) {
			return res.send('Invalid or expired token');
		}

		const hashedPassword = await bcrypt.hash(password, 12);
		await pool.query(`
			INSERT INTO admins (email, password_hash, name)
			VALUES ($1, $2, $3)
			ON CONFLICT (email) DO UPDATE 
			SET password_hash = $2, name = $3
		`, [email, hashedPassword, name || email]);

		// Auto login
		req.session.admin = true;
		req.session.adminEmail = email;
		res.redirect('/admin/dashboard');
	} catch (e) {
		console.error(e);
		res.send('Error creating account');
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
