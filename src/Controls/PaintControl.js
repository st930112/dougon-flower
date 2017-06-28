import {BezierSpline} from '../model/Spline';
import {Floral} from '../model/stem';
import CurveManagement from '../model/CurveManagement';
import * as UI from '../model/UIManagement';

const error = 50;

function PaintControl(pannel) {
	let rawPointData = [];
	let paintingPolyLine = undefined;	

	this.start = function( point ) {
		rawPointData.push( point );

		// const marker = pannel.marker(10, 10, function(add) {
		// 	let c = add.circle(2);
		// 	c.cx(5).cy(5).fill('red');

		// });
		// paintingPolyLine = pannel.polyline().fill('none').stroke({ width: 3, dashArray:'3,5' });
		// paintingPolyLine.marker('mid', marker);

	};
	this.update = function( point ) {
		rawPointData.push( point );
		// updateLines( paintingPolyLine, rawPointData);
	};

	this.end = function() {
		let smoothBizer = BezierSpline.makeByPoints( rawPointData, error );
		if(smoothBizer.length == 0) {
			clearRawData();
			return;
		}
		let aspect = UI.state.aspect;
		CurveManagement.floralScene.push( new Floral(smoothBizer,UI.state.flowerSize, UI.state.trunkHead, UI.state.trunkTail,'海石榴華', aspect) );
		
		CurveManagement.draw();
		clearRawData();
	};

	function updateLines(paintingPolyLine, rawPointData) {
		paintingPolyLine.plot( rawPointData );
	}
	
	function clearRawData(){
		rawPointData = [];
		paintingPolyLine.remove();
	}	
}

export default PaintControl;