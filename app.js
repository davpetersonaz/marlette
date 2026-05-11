//app.js
require('dotenv').config();
const nodemailer = require('nodemailer');
const express = require('express');
const path = require('path');
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
	res.render('index', { submitted: req.query.submitted });
});

app.get('/meet-the-team', (req, res) => {
	res.render('meet-the-team');
});

app.get('/contact', (req, res) => {
	res.render('contact', { 
		submitted: req.query.submitted === 'true',
		error: req.query.error === 'true'
	});
});

// CONTACT FORM - EMAIL SENDING
app.post('/contact', async (req, res) => {
	const { firstName, lastName, email, phone, message } = req.body;
	console.log('📧 New contact from:', `${firstName} ${lastName} <${email}>`);

	try {
		// Create transporter (using Gmail - easiest for now)
		const transporter = nodemailer.createTransport({
			service: 'gmail',
			auth: {
				user: process.env.EMAIL_USER,
				pass: process.env.EMAIL_PASS
			}
		});

		await transporter.sendMail({
			from: `"Marlette Precinct Website" <${process.env.EMAIL_USER}>`,
			to: process.env.EMAIL_USER,
			replyTo: email,
			subject: `New Message from ${firstName} ${lastName}`,
			html: `
				<h2>New Message from Marlette Precinct Website</h2>
				<p><strong>Name:</strong> ${firstName} ${lastName}</p>
				<p><strong>Email:</strong> ${email}</p>
				${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ''}
				<hr>
				<p><strong>Message:</strong></p>
				<p>${message.replace(/\n/g, '<br>')}</p>
			`
		});

    console.log('✅ Email sent successfully');
		res.redirect('/contact?submitted=true');
	} catch (error) {
    console.error('❌ Email failed:', error);
		res.redirect('/contact?error=true');
	}
});


module.exports = app;
if (require.main === module) {
	const PORT = process.env.PORT || 3000;
	app.listen(PORT, () => {
		console.log(`🚀 Server running on http://localhost:${PORT}`);
	});
}