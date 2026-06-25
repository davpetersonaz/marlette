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

// Pass current page name to all templates
app.use((req, res, next) => {
	// Admin status
	res.locals.adminLoggedIn = !!req.session.admin;
	res.locals.adminName = req.session.adminName || null;

	// Page name
	let pageName = 'home';
	if (req.path === '/meet-the-team'){ pageName = 'meet_the_team'; }
	else if (req.path === '/accomplishments'){ pageName = 'accomplishments'; }
	else if (req.path === '/whats-a-pc'){ pageName = 'whats-a-pc'; }
	else if (req.path === '/forrestwoodwick'){ pageName = 'forrestwoodwick'; }
	else if (req.path === '/contact'){ pageName = 'contact'; }
	else if (req.path.startsWith('/admin')){ pageName = 'admin'; }

	res.locals.pageName = pageName;
	next();
});

// PostgreSQL Pool
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: false
});

// Admin Protection Middleware
const requireAdmin = (req, res, next) => {
	if (!req.session.admin) {
		return res.redirect('/admin/login');
	}
	next();
};

// Make important env vars available to all EJS templates
app.use((req, res, next) => {
	res.locals.GOOGLE_SITE_KEY = process.env.GOOGLE_SITE_KEY || '';
	next();
});

// apply form rate limiter
const rateLimit = require('express-rate-limit');
const contactLimiter = rateLimit({
	windowMs: 30 * 60 * 1000, // 30 minutes
	max: 2, // max 3 submissions per IP
	message: 'Too many submissions. Please try again later.'
});

// Routes
app.get('/', (req, res) => res.render('index'));
app.get('/meet-the-team', (req, res) => res.render('meet-the-team'));
app.get('/accomplishments', (req, res) => res.render('accomplishments'));
app.get('/whats-a-pc', (req, res) => res.render('whats-a-pc'));
app.get('/forrestwoodwick', (req, res) => res.render('forrestwoodwick'));
app.get('/contact', contactLimiter, async (req, res) => {
	res.render('contact', { 
		submitted: req.query.submitted === 'true',
		error: req.query.error === 'true',
		showVolunteerOptions: false
	});
});
app.get('/volunteer', (req, res) => {
	res.render('contact', { 
		submitted: req.query.submitted === 'true',
		error: req.query.error === 'true',
		showVolunteerOptions: true
	});
});

// CONTACT / VOLUNTEER FORM
app.post('/contact', contactLimiter, async (req, res) => {
	const { firstName, lastName, email, phone, message, volunteerOptions, recaptchaToken, honeypot } = req.body;

	// Reject spam bots
	if (req.body.website && req.body.website.length > 0) {
		console.log('🚫 Honeypot caught spam attempt');
		return res.redirect('/contact?submitted=true'); // silent success for bots
	}

	// reCAPTCHA Verification
	if (!recaptchaToken) { return res.redirect('/contact?error=true'); }
	try {
		const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`;
		const verifyResponse = await fetch(verifyUrl);
		const verifyData = await verifyResponse.json();

		if (!verifyData.success || verifyData.score < 0.5) {
			console.log('reCAPTCHA failed or low score:', verifyData);
			return res.redirect('/contact?error=true');
		}
	} catch (e) {
		console.error('reCAPTCHA verification error:', e);
		return res.redirect('/contact?error=true');
	}

	try {
		await pool.query(`
			INSERT INTO submissions 
			(type, first_name, last_name, email, phone, message, volunteer_options)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, 
		[
			volunteerOptions && volunteerOptions.length > 0 ? 'volunteer' : 'contact',
			firstName,
			lastName,
			email,
			phone || null,
			message || null,
			Array.isArray(volunteerOptions) ? volunteerOptions : []
		]);

		// Send emails to multiple recipients
		const recipients = process.env.EMAIL_USER.split(',').map(e => e.trim());

		// Send email notification
		const transporter = nodemailer.createTransport({
			service: 'gmail',
			auth: {
				user: recipients[0],	// Use first email for sending
				pass: process.env.EMAIL_PASS
			}
		});

		const emailContent = `
			<h2>New Submission</h2>
			<p><strong>Name:</strong> ${firstName} ${lastName}</p>
			<p><strong>Email:</strong> ${email}</p>
			${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ''}
			${message ? `<p><strong>Message:</strong><br>${message.replace(/\n/g, '<br>')}</p>` : ''}
			${volunteerOptions && volunteerOptions.length ? `<p><strong>Volunteer Interests:</strong> ${volunteerOptions.join(', ')}</p>` : ''}
    	`;

		// Send to all recipients
		await transporter.sendMail({
			from: `"Marlette Precinct" <${recipients[0]}>`,
			to: recipients.join(', '),
			replyTo: email,
			subject: `New ${volunteerOptions?.length ? 'Volunteer' : 'Contact'} Submission`,
			html: emailContent
		});
		res.redirect('/contact?submitted=true');
	} catch (err) {
		console.error('Submission error:', err);
		res.redirect('/contact?error=true');
	}
});

// ADMIN ROUTES
app.get('/admin', (req, res) => {
	res.redirect(req.session.admin ? '/admin/dashboard' : '/admin/login');
});

app.get('/admin/login', (req, res) => {
	res.render('admin-login', { error: false });
});

// ADMIN LOGIN - Uses real admins table
app.post('/admin/login', async (req, res) => {
	const { username, password } = req.body;
	try {
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
			req.session.adminName = admin.name || admin.email;
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
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
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
app.post('/admin/highlight', requireAdmin, async (req, res) => {
	const { id, highlighted } = req.body;
	await pool.query('UPDATE submissions SET highlighted = $1 WHERE id = $2', [highlighted, id]);
	res.sendStatus(200);
});

// Get single submission for modal
app.get('/admin/submission/:id', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM submissions WHERE id = $1', 
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Submission not found' });
        }
        res.json(result.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database error' });
    }
});

// Export to CSV
app.get('/admin/export-csv', requireAdmin, async (req, res) => {
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

app.post('/admin/delete', requireAdmin, async (req, res) => {
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
	req.session.destroy(() => res.redirect('/'));
});

// ====================== INVITE SYSTEM ======================

// Invite Page
app.get('/admin/invite', requireAdmin, (req, res) => {
	res.render('admin-invite', { success: false, error: false });
});

app.post('/admin/invite', requireAdmin, async (req, res) => {
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
		req.session.adminName = name || email;
		res.redirect('/admin/dashboard');
	} catch (e) {
		console.error(e);
		res.send('Error creating account');
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
