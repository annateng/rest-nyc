require('dotenv').config();
const { Client } = require('@googlemaps/google-maps-services-js');
const { BitlyClient } = require('bitly');
const moment = require('moment-timezone');
const logger = require('../utils/logger');
const queries = require('../utils/queries');
const pool = require('../bin/db');

const client = new Client({});
const bitlyClient = new BitlyClient(process.env.BITLY_ACCESS_TOKEN, {});

const notFoundStr = 'Address not found.';
const multiResStr = 'Multiple address matches. Please be more specific.';

const helpText = `Welcome to Ask George!
 
Text us your address and we'll send you the closest restrooms to you.
Try an an intersection ("45th st & 8th Ave") or a street address ("150 Park Ave, Manhattan").

1-325-8-LET-ME-P
1-325-853-8637
ask-george.herokuapp.com`;

const getSearchStr = (input) => {
  const txt = input.trim();

  const hasZip = txt.match(/\d{5}$/);
  const hasState = txt.match(/NY \d{5}/i) || txt.match(/,\s*NY/) || txt.match(/\sNY$/);
  const hasCity = txt.match(/New York/i)
    || txt.match(/Brooklyn/i)
    || txt.match(/queens/i)
    || txt.match(/staten island/i)
    || txt.match(/manhattan/i)
    || txt.match(/bronx/i)
    || txt.match(/nyc/i);

  // if zip is included, or city + state, search as is
  if (hasZip || (hasCity && hasState)) return txt.replace(/\s/g, '+');

  // if city but no state, add NY and search
  if (hasCity && !hasState) return `${txt.replace(/\s/g, '+')}+NY`;

  // no city, add New York, NY
  if (!hasCity) return `${txt.replace(/\s/g, '+')}+New+York,+NY`;

  return txt.replace(/\s/g, '+');
};

const getResponseStr = (res) => {
  const placeDetailPromiseArr = res.rows.map((r) => new Promise((resolve, reject) => {
    client.placeDetails({
      params: {
        key: process.env.GOOGLE_MAPS_API_KEY,
        place_id: r.place_id,
      },
    })
      .then((placeDetails) => {
        // logger.info(placeDetails.data.result);
        // account for temp closing
        //  eslint-disable-next-line no-param-reassign
        if (placeDetails.data.result.business_status === 'CLOSED_TEMPORARILY') r.hours = 'Temporarily Closed';
        resolve({
          api_hours: placeDetails.data.result.opening_hours,
          api_name: placeDetails.data.result.name,
          business_status: placeDetails.data.result.business_status,
          url: placeDetails.data.result.url,
          ...r,
        });
      })
      .catch((err) => reject(err));
  }));

  return Promise.all(placeDetailPromiseArr)
    .then((details) => {
      // logger.info('DETAILS', details); // DEBUG
      // update hours in database
      details.forEach((det) => {
        if (det.api_hours) {
          const hoursString = det.api_hours.weekday_text.join('\n');
          pool.query(queries.updateHours, [hoursString, det.id]);
          det.hours = hoursString; // eslint-disable-line no-param-reassign
        }
      });

      // update name in database
      details.forEach((det) => {
        if (!det.name && det.api_name) {
          pool.query(queries.updateName, [det.api_name, det.id]);
        }
      });

      // create output string
      const outputPromiseArr = details.map((det) => new Promise((resolve, reject) => {
        // convert utc date to eastern
        const today = moment().tz('America/New_York').day();
        // logger.info(today); // DEBUG
        // logger.info(moment().tz('America/New_York'));

        // google api goes monday -> sunday. js goes sunday -> saturday
        const dayNo = (today + 5) % 6;
        // logger.info(dayNo, new Date().getDay());

        const name = det.name ? det.name : det.api_name;
        const distance = det.distance < 0.1 ? '<0.1 mi' : `${Math.trunc(det.distance)}.${Math.trunc(det.distance * 10) % 10} mi`;
        const type = det.category ? det.category : 'na';

        let hours;
        if (det.api_hours) hours = det.api_hours.weekday_text[dayNo].replace(':', ',');
        else if (det.hours) hours = det.hours;
        else hours = 'na';

        bitlyClient.shorten(det.url)
          .then((shortUrl) => {
            // logger.info(shortUrl);

            resolve(`
Name: ${name}
Type: ${type}
Distance: ${distance}
Hours: ${hours}
Directions: ${shortUrl.id}
          `.trim());
          })
          .catch((err) => reject(err));
      }));

      return Promise.all(outputPromiseArr);
    })
    .then((outputStrs) => {
      outputStrs.push('Text NEXT for more results');
      return outputStrs.join('\n\n');
    })
    .catch((err) => logger.error(err));
};

const newSearch = (Body, From) => {
  // query google api for user current location
  const searchStr = getSearchStr(Body);
  logger.info(searchStr); // DEBUG

  return client.geocode({
    params: {
      address: searchStr,
      key: process.env.GOOGLE_MAPS_API_KEY,
    },
  })
    .then((res) => {
      // logger.info(res.data.results); // DEBUG
      // throw err to break out of primise chain here
      if (res.data.status !== 'OK') throw new Error(notFoundStr);
      if (res.data.results.length > 1) throw new Error(multiResStr);

      const locData = res.data.results[0];
      const { lng, lat } = locData.geometry.location;

      // update current lng/lat in database
      pool.query(queries.updateLoc, [lng, lat, From]);

      return pool.query(queries.selectNearest, [lat, lng, 5, 0]);
    })
    .then((bathroomData) => {
      // increment current page no
      pool.query(queries.incrementPageNo, [1, From]);
      return getResponseStr(bathroomData, 0);
    })
    .catch((err) => {
      if (err.message === notFoundStr || err.message === multiResStr) return err.message;
      throw err;
    });
};

const nextPage = (pageNo, From) => {
  const offset = pageNo ? pageNo * 5 : 0;
  logger.info(pageNo);
  // get current lat/lng
  return pool.query(queries.getLoc, [From])
    .then((loc) => {
      const { active_loc_lng: lng, active_loc_lat: lat } = loc.rows[0];
      return pool.query(queries.selectNearest, [lat, lng, 5, offset]);
    })
    .then((bathroomData) => {
      logger.info(bathroomData.rows);
      if (bathroomData.length === 0) return 'No more results';
      // increment current page no
      pool.query(queries.incrementPageNo, [pageNo + 1, From]);
      return getResponseStr(bathroomData);
    })
    .catch((err) => { throw err; });
};

// check whether user is actively searching. Timeout is 10 minutes.
const checkActive = (from) => pool.query(queries.getDiffLastActive, [from])
  .then((res) => {
    if (typeof res.rows[0].age.minutes === 'undefined' || res.rows[0].age.minutes < 10) return true;
    return false;
  })
  .catch((err) => { throw err; });

const getResponse = (body) => {
  const {
    Body, From, FromCity, FromState, FromCountry, FromZip,
  } = body;

  // check if first time user
  return pool.query(queries.checkUserQuery, [From])
    .then((res) => {
      const resCount = res.rows[0].count;

      // duplicate phone number: throw error
      if (resCount.count > 1) {
        throw new Error(`Duplicate phone number in DB for ${From}`);
      }

      // user not found: create new user
      if (resCount === '0') {
        return pool.query(queries.newUserQuery, [From, FromCity, FromState, FromCountry, FromZip])
          .then(() => {
            // record text
            pool.query(queries.recordTextQuery, [From, Body]);
            // update last active
            pool.query(queries.updateActive, [From]);
            return helpText;
          });
      }

      // add query to texts received table
      pool.query(queries.recordTextQuery, [From, Body]);
      pool.query(queries.updateActive, [From]);
      return checkActive(From)
        .then((isActive) => {
          // if user said "Next" and he's active, get next page of results
          if (isActive && Body.toLowerCase().trim() === 'next') {
            return pool.query(queries.getPageNo, [From])
              .then((pageNo) => nextPage(pageNo.rows[0].next_page_no, From));
          }
          // if user said "next" and he's not active, send him the help message
          if (!isActive && Body.toLowerCase().trim() === 'next') {
            return helpText;
          }

          // else, initiate new search
          return newSearch(Body, From);
        });
    })
    .catch((err) => logger.error(err));
};

module.exports = { getResponse };
